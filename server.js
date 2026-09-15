const path = require("path");
const express = require("express");
const { migrate } = require("./db");
const authRoutes = require("./auth-routes");
const stateRoutes = require("./state-routes");

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/state", stateRoutes);

// Frontend files are served explicitly (not via a static folder) so that
// only these exact files are ever exposed publicly.
const FRONTEND_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/manifest.webmanifest": "manifest.webmanifest",
  "/service-worker.js": "service-worker.js",
  "/icon.svg": "icon.svg"
};

for (const [route, file] of Object.entries(FRONTEND_FILES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

// Anything else (that isn't an API route) falls back to the app shell.
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Sousa Group One backend listening on :${PORT}`));
  })
  .catch(err => {
    console.error("Database migration failed:", err);
    process.exit(1);
  });
