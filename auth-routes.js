const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("./db");
const { requireAuth } = require("./auth-middleware");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email et mot de passe requis." });
  }
  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [String(email).toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    await pool.query(
      `INSERT INTO audit_logs (user_email, action, metadata) VALUES ($1,$2,$3)`,
      [user.email, "Connexion", JSON.stringify({ role: user.role })]
    );

    res.json({
      token,
      profile: {
        email: user.email,
        role: user.role,
        name: user.name,
        avatar: user.avatar,
        company: user.company
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT email, role, name, avatar, company FROM users WHERE id = $1", [req.user.sub]);
    if (!rows[0]) return res.status(404).json({ error: "Utilisateur introuvable." });
    res.json({ profile: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

module.exports = router;
