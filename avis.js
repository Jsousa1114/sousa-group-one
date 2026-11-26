"use strict";
// The review request page: the Google review for everyone, a private message, or no more e-mails.
(() => {
  const token = new URLSearchParams(location.search).get("t") || "";
  const root = document.getElementById("revContent");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const api = async (path = "", body) => {
    const r = await fetch("/api/reviews-public/" + encodeURIComponent(token) + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || "Le service ne répond pas. Réessayez plus tard.");
    return out;
  };
  function render(d) {
    root.innerHTML = `<p>Votre avis aide d’autres personnes à choisir ${esc(d.company || "notre entreprise")} et nous aide à nous améliorer.</p><div class="review-choices"><button type="button" class="btn primary" id="revGoogle">Laisser un avis sur Google</button></div><section class="card review-form-card"><h2>Une remarque à nous faire ?</h2><p class="muted">Écrivez-nous directement : votre message arrive à l’entreprise (il n’est pas publié).</p>${
      d.feedbackSent
        ? '<p class="pub-ok">Merci, votre message a bien été transmis.</p>'
        : '<form class="review-form" id="revForm"><label for="revText" class="sr-only">Votre message</label><textarea id="revText" maxlength="3000" required placeholder="Votre message"></textarea><button type="submit" class="btn secondary">Envoyer le message</button></form>'
    }</section><p class="muted">${d.optedOut ? "Vous ne recevrez plus ce type de message." : '<button type="button" class="link-btn" id="revStop">Ne plus recevoir ce type de message</button>'}</p><p id="revState" class="muted" aria-live="polite"></p>`;
  }
  root.addEventListener("click", async (e) => {
    const state = document.getElementById("revState");
    try {
      if (e.target.id === "revGoogle") {
        const { url } = await api("/google", {});
        if (url) location.href = url;
      } else if (e.target.id === "revStop") {
        await api("/optout", {});
        e.target.parentElement.textContent = "C’est noté : vous ne recevrez plus ce type de message.";
      }
    } catch (err) {
      state.textContent = err.message;
    }
  });
  root.addEventListener("submit", async (e) => {
    if (e.target.id !== "revForm") return;
    e.preventDefault();
    const state = document.getElementById("revState");
    try {
      await api("/feedback", { text: document.getElementById("revText").value });
      e.target.outerHTML = '<p class="pub-ok">Merci, votre message a bien été transmis.</p>';
    } catch (err) {
      state.textContent = err.message;
    }
  });
  (async () => {
    try {
      const d = await api();
      if (["home", "electricite", "tech", "moving", "solar", "events"].includes(d.companyId)) document.body.dataset.brand = d.companyId;
      if (d.company) {
        document.getElementById("revCompany").textContent = d.company;
        document.title = "Votre avis · " + d.company;
      }
      render(d);
    } catch (e) {
      root.innerHTML = `<p class="pub-error">${esc(e.message)}</p>`;
    }
  })();
})();
