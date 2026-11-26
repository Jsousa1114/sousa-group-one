"use strict";
// The exchange's settings (Asterisk), written by the application into the folder it shares
// with the exchange: the Swiss operator's account, one line per person (their browsers), the
// relay for calls away from the office, the public address of the office. Plain text, tested
// without Asterisk.
const fs = require("node:fs");
const path = require("node:path");

const PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8"];
// An operator on the office network: the Internet-Box itself (Swisscom « Téléphonie IP locale »).
const isLocal = (host) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(host || ""));

// A value on one line: no line breaks, and « ; » (a comment in Asterisk files) escaped.
const value = (v) => String(v ?? "").replace(/[\r\n\0]/g, "").replace(/;/g, "\\;").trim();
const hostPort = (host, port) => (port && !/:\d+$/.test(host) ? `${host}:${port}` : host);
const endpointOf = (userId) => "sgo" + Number(userId);
const section = (name, rows) => [`[${name}]`, ...rows.filter(Boolean).map(([k, v]) => `${k} = ${value(v)}`), ""].join("\n");

// The first relay address usable by the exchange (host:port, UDP), from the URLs the relay
// service gives (turn:relay.example.com:3478?transport=udp, turns:…:443?transport=tcp).
function relayHost(urls = []) {
  for (const url of urls) {
    const m = String(url).match(/^turn:([^?\s]+?)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i);
    if (m && (!m[3] || m[3].toLowerCase() === "udp")) return `${m[1]}:${m[2] || 3478}`;
  }
  return "";
}
function stunHost(stun = "") {
  const m = String(stun || "").match(/^(?:stun:)?([^?\s:]+)(?::(\d+))?$/i);
  return m ? `${m[1]}:${m[2] || 3478}` : "";
}

function pjsip({ operator = null, lines = [], publicIp = "", sipPort = 5060 }) {
  const out = [];
  out.push(
    section("global", [
      ["type", "global"],
      ["user_agent", "Sousa Group One"],
      // The browsers are recognised by their name first; the operator by its address.
      ["endpoint_identifier_order", "username,ip"],
      ["keep_alive_interval", 25],
      ["max_initial_qualify_time", 10],
    ]),
  );
  out.push(
    section("transport-udp", [
      ["type", "transport"],
      ["protocol", "udp"],
      ["bind", `0.0.0.0:${sipPort}`],
      ...PRIVATE_NETS.map((n) => ["local_net", n]),
      publicIp && ["external_media_address", publicIp],
      publicIp && ["external_signaling_address", publicIp],
    ]),
  );
  out.push(section("transport-ws", [["type", "transport"], ["protocol", "ws"], ["bind", "0.0.0.0"]]));

  if (operator?.host && operator?.username) {
    const host = hostPort(operator.host, operator.port);
    const authUser = operator.authUsername || operator.username;
    out.push(section("operator-auth", [["type", "auth"], ["auth_type", "userpass"], ["username", authUser], ["password", operator.password || ""]]));
    // Some operators are reached through a separate entry point (Swisscom « SIP Credentials »:
    // voip.swisscom.ch through fs1.voip.swisscom.ch).
    const proxy = operator.outboundProxy ? `sip:${operator.outboundProxy.replace(/^sips?:/i, "")};lr` : "";
    // The Internet-Box only knows its own device (internal number): the person's mobile cannot be
    // shown through it, the From must be that device.
    const fromUser = operator.fromUser || (isLocal(operator.host) ? operator.username : "");
    out.push(section("operator", [["type", "aor"], ["contact", `sip:${host}`], ["qualify_frequency", 60], proxy && ["outbound_proxy", proxy]]));
    out.push(
      section("operator", [
        ["type", "endpoint"],
        ["transport", "transport-udp"],
        ["context", "from-trunk"],
        ["disallow", "all"],
        ["allow", "alaw,ulaw,g722"],
        ["outbound_auth", "operator-auth"],
        ["aors", "operator"],
        ["from_domain", operator.fromDomain || operator.host],
        fromUser && ["from_user", fromUser],
        proxy && ["outbound_proxy", proxy],
        // The person's own mobile number is shown to the people called (« CLIP no screening »,
        // to be enabled by the operator): sent in From and P-Asserted-Identity.
        ["send_pai", "yes"],
        ["trust_id_outbound", "yes"],
        ["direct_media", "no"],
        ["rtp_symmetric", "yes"],
        ["force_rport", "yes"],
        ["rewrite_contact", "yes"],
        ["dtmf_mode", "rfc4733"],
        ["timers", "no"],
      ]),
    );
    out.push(section("operator-identify", [["type", "identify"], ["endpoint", "operator"], ["match", operator.host], operator.outboundProxy && ["match", operator.outboundProxy.replace(/^sips?:/i, "").replace(/:\d+$/, "")]]));
    if (operator.register !== false)
      out.push(
        section("operator-registration", [
          ["type", "registration"],
          ["transport", "transport-udp"],
          ["outbound_auth", "operator-auth"],
          ["server_uri", `sip:${host}`],
          ["client_uri", `sip:${operator.username}@${operator.host}`],
          ["contact_user", operator.username],
          proxy && ["outbound_proxy", proxy],
          ["retry_interval", 60],
          ["forbidden_retry_interval", 300],
          ["fatal_retry_interval", 300],
          ["max_retries", 100000],
          ["expiration", 300],
          // Calls coming back on this registration are recognised as the operator's.
          ["line", "yes"],
          ["endpoint", "operator"],
        ]),
      );
  }

  for (const line of lines) {
    const name = endpointOf(line.userId);
    out.push(section(name, [["type", "auth"], ["auth_type", "userpass"], ["username", name], ["password", line.secret]]));
    out.push(section(name, [["type", "aor"], ["max_contacts", 6], ["remove_existing", "yes"], ["remove_unavailable", "yes"]]));
    out.push(
      section(name, [
        ["type", "endpoint"],
        ["transport", "transport-ws"],
        ["context", "from-app"],
        ["disallow", "all"],
        ["allow", "alaw,ulaw,opus"],
        ["webrtc", "yes"],
        ["auth", name],
        ["aors", name],
        ["callerid", `"${String(line.name || "").replace(/["<>]/g, "")}" <${line.did || ""}>`],
        ["device_state_busy_at", 1],
      ]),
    );
  }
  return out.join("\n");
}

function rtp({ relay = {}, rtpStart = 10000, rtpEnd = 10299 }) {
  const rows = [
    ["rtpstart", rtpStart],
    ["rtpend", rtpEnd],
    ["icesupport", "yes"],
  ];
  const stun = stunHost(relay.stun);
  if (stun) rows.push(["stunaddr", stun]);
  const turn = relayHost(relay.turnUrls);
  if (turn && relay.turnUser) rows.push(["turnaddr", turn], ["turnusername", relay.turnUser], ["turnpassword", relay.turnPassword || ""]);
  return section("general", rows);
}

function ari({ password }) {
  return [section("general", [["enabled", "yes"], ["pretty", "no"], ["allowed_origins", ""]]), section("sgo", [["type", "user"], ["read_only", "no"], ["password", password]])].join("\n");
}

// The exchange's manager account: the application only reads the operator connection state.
function manager({ amiPassword }) {
  return section("sgo", [["secret", amiPassword], ["deny", "0.0.0.0/0.0.0.0"], ...PRIVATE_NETS.map((n) => ["permit", n.replace(/\/(\d+)$/, (m, bits) => "/" + maskOf(Number(bits)))]), ["read", "system,reporting"], ["write", "system,reporting"]]);
}
function maskOf(bits) {
  const n = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

function files(settings) {
  return {
    "pjsip.conf": pjsip(settings),
    "rtp.conf": rtp(settings),
    "ari.conf": ari({ password: settings.ariPassword }),
    ...(settings.amiPassword ? { "manager.conf": manager(settings) } : {}),
  };
}

// Written atomically; « ready » tells the exchange it may start (first start only).
function write(dir, contents) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const changed = [];
  for (const [name, text] of Object.entries(contents)) {
    const file = path.join(dir, name);
    let before = null;
    try {
      before = fs.readFileSync(file, "utf8");
    } catch {
      before = null;
    }
    if (before === text) continue;
    fs.writeFileSync(file + ".tmp", text, { mode: 0o640 });
    fs.renameSync(file + ".tmp", file);
    changed.push(name);
  }
  fs.writeFileSync(path.join(dir, "ready"), new Date().toISOString());
  return changed;
}

module.exports = { files, write, pjsip, rtp, ari, manager, relayHost, stunHost, endpointOf, value, isLocal };
