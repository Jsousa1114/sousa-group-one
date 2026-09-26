"use strict";
const path = require("node:path"),
  express = require("express");
const { pool, migrate } = require("./db");
function createApp(db = pool) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
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
  app.use("/api/state", require("./state-routes").routes(db));
  app.use("/api/messaging", require("./messaging-routes").routes(db));
  app.get(["/favicon.ico", "/icon.svg"], (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.redirect(302, "/assets/logos/group.png?v=group-20260926");
  });
  for (const file of [
    "index.html",
    "app.js",
    "finance.js",
    "messaging-crypto.js",
    "styles.css",
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
    if (err.code === "23505")
      return res.status(409).json({ error: "Cet élément existe déjà." });
    const status = err.status || 500;
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
      return server;
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
module.exports = { createApp };
