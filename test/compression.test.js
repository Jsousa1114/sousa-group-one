"use strict";
process.env.JWT_SECRET = "compression-test-secret-long-enough-2026";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.once("data", (chunk) => {
        resolve({ status: res.statusCode, headers: res.headers, first: chunk });
        req.destroy();
      });
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, first: null }));
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    req.setTimeout(5000, () => reject(new Error("timeout " + path)));
  });
}

test("static assets are gzip-compressed and live events stay uncompressed", async () => {
  const db = await database();
  let server;
  try {
    await migrate(db);
    const hash = await bcrypt.hash("Compression-Test-2026", 4);
    await db.query(
      "INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,'admin','Compression Admin','','group')",
      ["compression@test.invalid", hash],
    );
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;

    const asset = await get(port, "/app.js", { "Accept-Encoding": "gzip" });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["content-encoding"], "gzip");

    const plain = await get(port, "/app.js");
    assert.equal(plain.headers["content-encoding"], undefined);

    const login = await fetch("http://127.0.0.1:" + port + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "compression@test.invalid", password: "Compression-Test-2026" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const events = await get(port, "/api/p2/events", { "Accept-Encoding": "gzip", Cookie: cookie });
    assert.equal(events.status, 200);
    assert.match(String(events.headers["content-type"]), /text\/event-stream/);
    assert.equal(events.headers["content-encoding"], undefined);
    assert.match(events.first.toString(), /retry: 3500/);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    await db.end();
  }
});
