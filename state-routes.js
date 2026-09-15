const express = require("express");
const { pool } = require("./db");
const { requireAuth } = require("./auth-middleware");

const router = express.Router();

// Returns the shared application state (employees, chantiers, devis, factures, etc.)
// Returns { data: null } the very first time, before anything has been saved yet.
router.get("/", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT data, updated_at FROM app_state WHERE id = 1");
    if (!rows[0]) return res.json({ data: null });
    res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Persists the whole application state as one document.
// The frontend already keeps a single in-memory "db" object it mutates locally;
// this endpoint is what makes that object survive reloads and be shared across users/devices.
router.post("/", requireAuth, async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "Données manquantes." });
  }
  try {
    await pool.query(
      `INSERT INTO app_state (id, data, updated_at, updated_by)
       VALUES (1, $1, NOW(), $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(data), req.user.email]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

module.exports = router;
