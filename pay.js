"use strict";
(() => {
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = (v) => new Intl.NumberFormat("fr-CH",{style:"currency",currency:"CHF"}).format(Number(v)||0);
  const token = new URLSearchParams(location.search).get("token") || "";
  const host = document.getElementById("payContent");
  async function load(){
    if(!/^[a-f0-9]{64}$/.test(token)){host.innerHTML="<p>Lien de paiement invalide.</p>";return;}
    try{
      const r=await fetch("/api/p1/payment/"+encodeURIComponent(token),{credentials:"omit"});
      const out=await r.json();
      if(!r.ok)throw new Error(out.error||"Lien indisponible.");
      const due=Math.max(0,Number(out.invoice.amount||0)-Number(out.invoice.paid||0));
      host.innerHTML=`
        <div class="pay-head"><span>Facture</span><strong>${esc(out.invoice.id)}</strong></div>
        <h1>${esc(out.invoice.title||"Facture")}</h1>
        <p>${esc(out.issuer.name)} → ${esc(out.client.name)}</p>
        <div class="pay-total"><small>Solde à payer</small><b>${money(due)}</b></div>
        <dl class="pay-details">
          <div><dt>Échéance</dt><dd>${esc(out.invoice.due||"—")}</dd></div>
          <div><dt>IBAN</dt><dd><code id="payIban">${esc(out.issuer.iban||"Non renseigné")}</code></dd></div>
          <div><dt>Référence</dt><dd><code id="payRef">${esc(out.invoice.paymentReference||out.invoice.id)}</code></dd></div>
        </dl>
        <div class="p1-actions">
          <button class="btn primary" data-copy="payIban">Copier l’IBAN</button>
          <button class="btn" data-copy="payRef">Copier la référence</button>
        </div>
        <p class="muted">Effectuez le paiement depuis votre banque en utilisant l’IBAN et la référence ci-dessus. Ce lien n’enregistre aucune donnée bancaire.</p>`;
    }catch(e){host.innerHTML="<p>"+esc(e.message)+"</p>";}
  }
  document.addEventListener("click",async(e)=>{
    const b=e.target.closest("[data-copy]");if(!b)return;
    const value=document.getElementById(b.dataset.copy)?.textContent||"";
    try{await navigator.clipboard.writeText(value);b.textContent="Copié ✓";}catch{}
  });
  load();
})();