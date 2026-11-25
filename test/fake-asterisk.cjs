"use strict";
// A stand-in for the exchange's control interface (Asterisk ARI): the REST calls the application
// makes are written down, the test sends the events (calls arriving, answered, hung up…).
// It also answers the browsers' WebSocket (/ws) by echoing, to check the application's proxy.
const http = require("node:http");
const { WebSocketServer } = require("ws");

function fakeAsterisk() {
  const calls = [];
  const endpoints = {};
  const channels = new Map();
  const variables = {};
  const originated = [];
  const playbacks = [];
  let n = 0;
  let app = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const query = {};
      for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
      const entry = { method: req.method, path: url.pathname.replace(/^\/ari/, ""), query, auth: req.headers.authorization || "" };
      calls.push(entry);
      const send = (status, body) => {
        res.statusCode = status;
        if (body !== undefined) res.setHeader("Content-Type", "application/json");
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const p = entry.path;
      let m;
      if (req.method === "GET" && (m = p.match(/^\/endpoints\/PJSIP\/([^/]+)$/))) return send(200, { resource: m[1], state: endpoints[m[1]] || "offline" });
      if (req.method === "POST" && p === "/channels") {
        const id = "orig-" + ++n;
        const name = String(query.endpoint || "").startsWith("Local/") ? `Local/${query.endpoint.slice(6)}-0000;1` : `PJSIP/${String(query.endpoint).split("@").pop()}-000${n}`;
        channels.set(id, { id, name });
        originated.push(id);
        return send(200, { id, name });
      }
      if (req.method === "GET" && (m = p.match(/^\/channels\/([^/]+)\/variable$/))) return send(200, { value: variables[query.variable] || "" });
      if (req.method === "GET" && (m = p.match(/^\/channels\/([^/]+)$/))) return channels.has(m[1]) ? send(200, channels.get(m[1])) : send(404, { message: "Channel not found" });
      if (req.method === "DELETE" && (m = p.match(/^\/channels\/([^/]+)$/))) {
        const id = m[1];
        if (!channels.has(id)) return send(404, { message: "Channel not found" });
        channels.delete(id);
        send(204);
        setTimeout(() => emit({ type: "ChannelDestroyed", cause: query.reason === "busy" ? 17 : 16, channel: { id } }), 5);
        return;
      }
      if (req.method === "POST" && p === "/bridges") return send(200, { id: "bridge-" + ++n });
      if (req.method === "POST" && /\/play$/.test(p)) {
        const id = "pb-" + ++n;
        playbacks.push(id);
        return send(201, { id, media_uri: query.media });
      }
      if (req.method === "POST" && /\/record$/.test(p)) return send(201, { name: query.name, state: "recording" });
      return send(204);
    });
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has("sip") ? "sip" : false) });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://fake");
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === "/ari/events") {
        app = ws;
        ws.auth = req.headers.authorization || "";
        return;
      }
      // /ws: the browsers' SIP connection, echoed back.
      ws.on("message", (data) => ws.send("echo:" + data));
    });
  });
  function emit(event) {
    if (app?.readyState === 1) app.send(JSON.stringify(event));
  }
  return {
    calls,
    endpoints,
    lastOriginated: () => originated.at(-1),
    lastPlayback: () => playbacks.at(-1),
    channels,
    variables,
    emit,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + server.address().port))),
    connected: () => app?.readyState === 1,
    appAuth: () => app?.auth || "",
    // A channel entering the application, as the dialplan would hand it over.
    channel(id, name, extra = {}) {
      channels.set(id, { id, name, ...extra });
      return { id, name, ...extra };
    },
    last: (method, pattern) => [...calls].reverse().find((c) => c.method === method && pattern.test(c.path)),
    all: (method, pattern) => calls.filter((c) => c.method === method && pattern.test(c.path)),
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

module.exports = { fakeAsterisk };
