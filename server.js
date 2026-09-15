const path = require("path");
const express = require("express");
const { migrate } = require("./db");
const authRoutes = require("./routes/auth");
const stateRoutes = require("./routes/state");

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/state", stateRoutes);

app.use(express.static(path.join(__dirname, "public")));

// Single-page app: any unknown non-API route falls back to index.html
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
