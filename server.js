"use strict";
const path = require("node:path"),
  { randomUUID } = require("node:crypto"),
  express = require("express");
const { pool, migrate } = require("./db");
function createApp(db = pool) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const rateBuckets = new Map();
  app.use((req, res, next) => {
    const requestId = req.headers["x-request-id"] || randomUUID();
    req.requestId = String(requestId).slice(0, 100);
    res.set("X-Request-Id", req.requestId);
    if (!req.path.startsWith("/api") || req.path === "/healthz") return next();
    const now = Date.now(),
      key = String(req.ip || req.socket.remoteAddress || "unknown"),
      bucket = rateBuckets.get(key) || { at: now, reads: 0, writes: 0 };
    if (now - bucket.at > 10 * 60 * 1000) {
      bucket.at = now;
      bucket.reads = 0;
      bucket.writes = 0;
    }
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (write) bucket.writes++;
    else bucket.reads++;
    rateBuckets.set(key, bucket);
    if (bucket.reads > 1200 || bucket.writes > 400)
      return res.status(429).json({
        error: "Trop de requêtes. Réessayez dans quelques minutes.",
      });
    if (rateBuckets.size > 5000)
      for (const [k, v] of rateBuckets)
        if (now - v.at > 10 * 60 * 1000) rateBuckets.delete(k);
    next();
  });
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy":
        "camera=(self), microphone=(self), geolocation=(self), payment=(self)",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (req.secure || process.env.RENDER)
      res.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "8mb" }));
  app.get("/healthz", async (req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.use("/api/auth", require("./auth-routes").routes(db));
  app.use("/api/account", require("./account-routes").routes(db));
  app.use("/api/passkeys", require("./passkey-routes").routes(db));
  app.use("/api/state", require("./state-routes").routes(db));
  app.use("/api/messaging", require("./messaging-routes").routes(db));
  app.use("/api/operations", require("./operations-routes").routes(db));
  app.use("/api/p1", require("./p1-routes").routes(db));
  app.use("/api/p2", require("./p2-routes").routes(db));
  app.use("/api/public/v1", require("./p2-routes").publicRoutes(db));
  app.get(["/favicon.ico", "/icon.svg"], (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.redirect(302, "/assets/logos/group.png?v=group-20260926");
  });
  for (const file of [
    "index.html",
    "core-ui.js",
    "app.js",
    "finance.js",
    "messaging-crypto.js",
    "messaging-suite.js",
    "account-center.js",
    "passkeys.js",
    "p3-center.js",
    "operations-center.js",
    "p1-suite.js",
    "p2-runtime.js",
    "p2-center.js",
    "styles.css",
    "messaging.css",
    "account.css",
    "operations.css",
    "p1.css",
    "p2.css",
    "pay.html",
    "pay.js",
    "manifest.webmanifest",
    "service-worker.js",
    ...[
      "group",
      "home",
      "electricite",
      "tech",
      "moving",
      "solar",
      "events",
    ].map((id) => `assets/logos/${id}.png`),
  ])
    app.get("/" + file, (req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(path.join(__dirname, file));
    });
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
  app.use((req, res) => res.status(404).json({ error: "Page introuvable." }));
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === "23505" ? 409 : 500);
    if (status >= 500)
      db.query(
        `INSERT INTO application_errors
         (request_id,user_id,method,path,status,message,stack,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          req.id || req.headers["x-request-id"] || null,
          req.user?.id || null,
          req.method,
          req.originalUrl || req.path,
          status,
          String(err.message || "Erreur serveur").slice(0, 4000),
          String(err.stack || "").slice(0, 12000),
          JSON.stringify({ code: err.code || null }),
        ],
      ).catch(() => {});
    if (err.code === "23505")
      return res.status(409).json({ error: "Cet élément existe déjà." });
    if (status >= 500) console.error(err);
    res.status(status).json({
      error:
        status >= 500
          ? "Erreur serveur. Aucune modification confirmée."
          : err.message,
    });
  });
  return app;
}
if (require.main === module) {
  if (
    !process.env.DATABASE_URL ||
    !process.env.JWT_SECRET ||
    process.env.JWT_SECRET.length < 32
  )
    throw new Error(
      "DATABASE_URL and JWT_SECRET (32+ characters) are required.",
    );
  migrate()
    .then(() => {
      const app = createApp();
      const server = app.listen(process.env.PORT || 3000);
      const cleanup = async () =>
        require("./messaging-routes").cleanupRetention(pool).catch((e) =>
          console.error("Messaging retention cleanup failed", e),
        );
      cleanup();
      const timer = setInterval(cleanup, 6 * 60 * 60 * 1000);
      timer.unref?.();
      const runRecurring = async () =>
        require("./operations-routes")
          .runDueRecurringJobs(pool)
          .catch((e) => console.error("Recurring work generation failed", e));
      runRecurring();
      const recurringTimer = setInterval(runRecurring, 60 * 60 * 1000);
      recurringTimer.unref?.();
      const runP1 = async () =>
        require("./p1-routes")
          .runDueJobs(pool)
          .catch((e) => console.error("P1 recurring jobs failed", e));
      runP1();
      const p1Timer = setInterval(runP1, 60 * 60 * 1000);
      p1Timer.unref?.();
      return server;
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
module.exports = { createApp };
