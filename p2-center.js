"use strict";
(() => {
  let host = null, active = "overview", cache = {};
  const core = () => window.SGOChatCore;
  const profile = () => core()?.getProfile?.() || {};
  const state = () => core()?.getState?.() || {};
  const esc = (v) => core()?.esc?.(v) ?? String(v ?? "");
  const api = (path, body) => core().api("p2/" + path, body);
  const ops = (path, body) => core().api("operations/" + path, body);
  const money = (v) => new Intl.NumberFormat("fr-CH",{style:"currency",currency:"CHF"}).format(Number(v)||0);
  const date = (v) => v ? new Date(v).toLocaleString("fr-CH",{timeZone:"Europe/Zurich"}) : "—";
  const direction = () => ["admin","direction"].includes(profile().role) || (profile().permission_grants||[]).some(x=>["admin","direction"].includes(x));
  const staff = () => ["admin","direction","hr","manager","accounting"].includes(profile().role) || (profile().permission_grants||[]).some(x=>["admin","direction","hr","manager","accounting"].includes(x));

  function button(label, action, attrs="", kind="") {
    return `<button type="button" class="btn ${kind}" data-p2-action="${esc(action)}" ${attrs}>${esc(label)}</button>`;
  }
  function card(title, body, actions="") {
    return `<article class="card p2-card"><div class="p2-card-head"><h3>${esc(title)}</h3><div>${actions}</div></div>${body}</article>`;
  }
  function tabs() {
    const items = [
      ["overview","État P2"],
      ...(staff() ? [["finance","Finance & rentabilité"],["approvals","Approbations"],["appointments","Rendez-vous"],["commercial","Commercial"]] : []),
      ...(direction() ? [["automations","Modèles"],["access","Accès & API"]] : []),
    ];
    if (!items.some(([id])=>id===active)) active="overview";
    return `<div class="p2-tabs">${items.map(([id,label])=>`<button class="${active===id?"active":""}" data-p2-tab="${id}">${esc(label)}</button>`).join("")}</div>`;
  }
  async function renderOverview() {
    const status = await api("status");
    const queue = await window.SGOP2Runtime?.listQueue?.().catch(()=>[]) || [];
    const f = status.features || {}, external = status.external || {};
    host.innerHTML = `
      <div class="p2-kpis">
        <article><b>${esc(status.completion?.corePercent||0)}%</b><span>Socle P2 interne</span></article>
        <article><b>${Object.values(f).filter(Boolean).length}/${Object.keys(f).length}</b><span>Fonctions actives</span></article>
        <article><b>${queue.length}</b><span>Action(s) hors ligne en attente</span></article>
        <article><b>${Object.values(external).filter(Boolean).length}/${Object.keys(external).length}</b><span>Connecteurs externes configurés</span></article>
      </div>
      ${card("Mobilité & temps réel",`
        <div class="p2-actions">
          ${button(window.SGOP2Runtime?.highReadability?.()?"Lisibilité normale":"Haute lisibilité","readability")}
          ${button(window.SGOP2Runtime?.tabletMode?.()?"Mode tablette : ON":"Mode tablette","tablet")}
          ${button("Synchroniser maintenant","sync","", "primary")}
          ${window.SGOP2Runtime?.canInstall?.()?button("Installer l’application","install","", "primary"):""}
          <a class="btn secondary" href="/api/p2/calendar.ics">Exporter mon planning (.ics)</a>
        </div>
        <p class="muted">Temps réel SSE, cache PWA, consultation hors ligne, file de synchronisation pour pointages et documents, installation mobile et passkeys biométriques.</p>
      `)}
      ${card("Connecteurs P2",`<div class="p2-status-grid">${Object.entries(external).map(([k,v])=>`<div class="${v?"ready":"pending"}"><b>${esc(k)}</b><span>${v?"Configuré":"Optionnel · à connecter"}</span></div>`).join("")}</div>`)}
      ${card("Couverture P2",`<div class="p2-feature-grid">${Object.entries(f).map(([k,v])=>`<span class="${v?"ready":"pending"}">✓ ${esc(k)}</span>`).join("")}</div>`)}
    `;
  }
  async function renderFinance() {
    const [a,c] = await Promise.all([ops("analytics"), api("cashflow?days=120")]);
    const byClient = a.byClient || [], max = Math.max(1,...(c.rows||[]).map(x=>Math.abs(Number(x.net)||0)));
    host.innerHTML = `
      <div class="p2-kpis">
        <article><b>${money(a.kpis?.invoiceRevenue)}</b><span>CA facturé</span></article>
        <article><b>${money(a.kpis?.outstanding)}</b><span>À encaisser</span></article>
        <article><b>${money(a.kpis?.expenses)}</b><span>Dépenses</span></article>
        <article><b>${money(c.total)}</b><span>Trésorerie prévisionnelle nette</span></article>
      </div>
      ${card("Prévision de trésorerie · 120 jours",`<div class="p2-chart">${(c.rows||[]).map(x=>`<div><span>${esc(x.week)}</span><i style="--p:${Math.max(3,Math.round(Math.abs(x.net)/max*100))}%"></i><b>${money(x.net)}</b></div>`).join("")||"<p>Aucun flux futur.</p>"}</div>`)}
      <div class="p2-grid">
        ${card("Rentabilité par entreprise",`<div class="table"><table><thead><tr><th>Entreprise</th><th>CA</th><th>Coûts</th><th>Marge brute</th></tr></thead><tbody>${(a.byCompany||[]).map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.revenue)}</td><td>${money(x.projectCost)}</td><td>${money((Number(x.revenue)||0)-(Number(x.projectCost)||0))}</td></tr>`).join("")}</tbody></table></div>`)}
        ${card("Rentabilité par client",`<div class="table"><table><thead><tr><th>Client</th><th>CA</th><th>Encaissé</th><th>Ouvert</th></tr></thead><tbody>${byClient.map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.revenue)}</td><td>${money(x.paid)}</td><td>${money(x.outstanding)}</td></tr>`).join("")}</tbody></table></div>`)}
      </div>
    `;
  }
  async function renderApprovals() {
    const out=await api("approvals"), rows=out.approvals||[];
    host.innerHTML=`
      <div class="p2-toolbar"><h3>Workflow d’approbation</h3>${button("Nouvelle demande","approval-new","", "primary")}</div>
      <div class="p2-list">${rows.map(x=>`<article class="card"><div><span class="status neutral">${esc(x.status)}</span><b>${esc(x.title)}</b><small>${esc(x.request_type)} · ${x.amount!=null?money(x.amount):"sans montant"} · ${date(x.created_at)}</small></div>${x.status==="pending"&&direction()?`<div>${button("Approuver","approval-decide",`data-id="${esc(x.id)}" data-status="approved"`,"primary")} ${button("Refuser","approval-decide",`data-id="${esc(x.id)}" data-status="rejected"`,"danger")}</div>`:""}</article>`).join("")||'<article class="card empty">Aucune validation.</article>'}</div>
    `;
  }
  async function renderAppointments() {
    const out=await api("appointments"), rows=out.appointments||[];
    host.innerHTML=`
      <div class="p2-toolbar"><h3>Rendez-vous clients</h3>${button("Nouveau rendez-vous","appointment-new","", "primary")}</div>
      <div class="p2-list">${rows.map(x=>`<article class="card"><div><span class="status neutral">${esc(x.status)}</span><b>${esc(x.title)}</b><small>${date(x.starts_at)} → ${date(x.ends_at)} · client ${esc(x.client_id)}</small></div>${x.status==="requested"&&staff()?`<div>${button("Confirmer","appointment-decision",`data-id="${esc(x.id)}" data-status="confirmed"`,"primary")} ${button("Refuser","appointment-decision",`data-id="${esc(x.id)}" data-status="cancelled"`,"danger")}</div>`:""}</article>`).join("")||'<article class="card empty">Aucun rendez-vous.</article>'}</div>
    `;
  }
  async function renderCommercial() {
    const out=await api("quote-reminders"), quotes=out.quotes||[];
    host.innerHTML=`
      <div class="p2-toolbar"><h3>Relances devis</h3></div>
      <div class="p2-list">${quotes.map(q=>`<article class="card"><div><b>${esc(q.id)} · ${esc(q.title||"Devis")}</b><small>${esc(q.status)} · ${money(q.amount)}</small></div><div>${button("Relance interne","quote-remind",`data-id="${esc(q.id)}" data-channel="notification"`)} ${button("E-mail","quote-remind",`data-id="${esc(q.id)}" data-channel="email"`)} ${button("SMS","quote-remind",`data-id="${esc(q.id)}" data-channel="sms"`)}</div></article>`).join("")||'<article class="card empty">Aucun devis à relancer.</article>'}</div>
    `;
  }
  async function renderAutomations() {
    const out=await api("automation-templates");
    host.innerHTML=`<div class="p2-toolbar"><h3>Modèles d’automatisation</h3></div><div class="p2-grid">${(out.templates||[]).map(x=>card(x.name,`<p class="muted">${esc(x.eventType)}</p>`,button("Installer","template-install",`data-id="${esc(x.id)}"`,"primary"))).join("")}</div>`;
  }
  async function renderAccess() {
    const [perms,keys]=await Promise.all([api("permissions"),api("api-keys")]);
    cache.permissions=perms.users||[];
    host.innerHTML=`
      <div class="p2-grid">
        ${card("Permissions personnalisées",`<div class="p2-list">${cache.permissions.map(u=>`<div><span><b>${esc(u.name)}</b><small>${esc(u.role)} · ${esc(u.company)} · +${esc((u.grant_roles||[]).join(", ")||"aucun")}</small></span>${button("Modifier","permission-edit",`data-id="${u.id}"`)}</div>`).join("")}</div>`)}
        ${card("API publique",`<div class="p2-actions">${button("Créer une clé API","api-key-new","", "primary")}</div><div class="p2-list">${(keys.keys||[]).map(k=>`<div><span><b>${esc(k.name)}</b><small>${esc((k.scopes||[]).join(", "))} · ${k.enabled?"active":"révoquée"}</small></span>${k.enabled?button("Révoquer","api-key-revoke",`data-id="${esc(k.id)}"`,"danger"):""}</div>`).join("")||"<p>Aucune clé.</p>"}</div>`)}
      </div>
    `;
  }
  async function renderClient() {
    const id=profile().client_id;
    const [history,appointments,status]=await Promise.all([api("client/"+encodeURIComponent(id)+"/history"),api("appointments"),api("status")]);
    const h=history;
    host.innerHTML=`
      <div class="p2-kpis">
        <article><b>${(h.projects||[]).length}</b><span>Chantiers</span></article>
        <article><b>${(h.quotes||[]).length}</b><span>Devis</span></article>
        <article><b>${(h.invoices||[]).length}</b><span>Factures</span></article>
        <article><b>${(appointments.appointments||[]).filter(x=>["requested","confirmed"].includes(x.status)).length}</b><span>Rendez-vous à venir</span></article>
      </div>
      ${card("Portail client avancé",`<p>Historique consolidé des chantiers, devis, factures, paiements, maintenance, messages et rendez-vous.</p><div class="p2-actions">${button("Demander un rendez-vous","appointment-new","", "primary")}<a class="btn secondary" href="/api/p2/calendar.ics">Planning .ics</a></div>`)}
      ${card("Rendez-vous",`<div class="p2-list">${(appointments.appointments||[]).map(x=>`<div><span><b>${esc(x.title)}</b><small>${date(x.starts_at)} · ${esc(x.status)}</small></span></div>`).join("")||"<p>Aucun rendez-vous.</p>"}</div>`)}
      ${card("Derniers éléments",`<div class="p2-list">${[...(h.projects||[]).map(x=>({t:"Chantier",n:x.title||x.id})),...(h.quotes||[]).map(x=>({t:"Devis",n:x.id})),...(h.invoices||[]).map(x=>({t:"Facture",n:x.id}))].slice(0,20).map(x=>`<div><span><b>${esc(x.t)}</b><small>${esc(x.n)}</small></span></div>`).join("")}</div>`)}
    `;
  }
  async function renderCurrent() {
    if (!host) return;
    host.innerHTML='<article class="card"><p>Chargement P2…</p></article>';
    try {
      if(profile().role==="client") return await renderClient();
      if(active==="overview") await renderOverview();
      else if(active==="finance") await renderFinance();
      else if(active==="approvals") await renderApprovals();
      else if(active==="appointments") await renderAppointments();
      else if(active==="commercial") await renderCommercial();
      else if(active==="automations") await renderAutomations();
      else if(active==="access") await renderAccess();
    } catch(e) {
      host.innerHTML=`<article class="card empty"><b>Impossible de charger P2.</b><p>${esc(e.message)}</p></article>`;
    }
  }
  async function render(root) {
    host=root;
    if(profile().role==="client") {
      root.innerHTML='<section class="p2-center"><div id="p2Body"></div></section>';
      host=root.querySelector("#p2Body");
      return renderCurrent();
    }
    root.innerHTML=`<section class="p2-center"><div class="p2-hero"><div><span>P2 · PERFORMANCE</span><h2>Mobilité, intégrations & pilotage avancé</h2></div></div>${tabs()}<div id="p2Body"></div></section>`;
    host=root.querySelector("#p2Body");
    await renderCurrent();
  }
  function modal(title,html){ core().modal(title,html); }
  function appointmentForm(){
    const clients=state().clients||[], projects=state().projects||[];
    const isClient=profile().role==="client";
    modal("Nouveau rendez-vous",`<form id="p2Form" data-kind="appointment">${isClient?"":`<label>Client<select name="clientId">${clients.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label>`}<label>Chantier (optionnel)<select name="projectId"><option value="">—</option>${projects.map(x=>`<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")}</select></label><label>Titre<input name="title" value="Rendez-vous" required></label><label>Début<input type="datetime-local" name="startsAt" required></label><label>Fin<input type="datetime-local" name="endsAt" required></label><label>Notes<textarea name="notes"></textarea></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
  }
  function approvalForm(){
    const companies=(state().companies||[]).filter(x=>x.id!=="group");
    modal("Demande d’approbation",`<form id="p2Form" data-kind="approval"><label>Entreprise<select name="company">${companies.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label><label>Type<select name="type"><option value="expense">Dépense</option><option value="quote">Devis</option><option value="purchase">Achat</option><option value="absence">Absence</option><option value="invoice">Facture</option><option value="other">Autre</option></select></label><label>Titre<input name="title" required></label><label>Montant CHF<input type="number" step="0.01" min="0" name="amount"></label><button class="btn primary" type="submit">Demander validation</button></form>`);
  }
  function permissionForm(id){
    const u=cache.permissions?.find(x=>String(x.id)===String(id)); if(!u)return;
    const packs=["direction","hr","manager","accounting","employee","client"];
    modal("Permissions · "+u.name,`<form id="p2Form" data-kind="permission"><input type="hidden" name="userId" value="${u.id}"><p class="muted">Ajoutez des packs d’accès en complément du rôle principal. Les restrictions restent limitées aux entreprises autorisées.</p><fieldset><legend>Accès supplémentaires</legend>${packs.map(x=>`<label class="p2-check"><input type="checkbox" name="grants" value="${x}" ${(u.grant_roles||[]).includes(x)?"checked":""}> ${x}</label>`).join("")}</fieldset><fieldset><legend>Refus explicites</legend>${packs.map(x=>`<label class="p2-check"><input type="checkbox" name="denials" value="${x}" ${(u.deny_roles||[]).includes(x)?"checked":""}> ${x}</label>`).join("")}</fieldset><button class="btn primary" type="submit">Enregistrer</button></form>`);
  }
  function apiKeyForm(){
    const companies=(state().companies||[]).filter(x=>x.id!=="group");
    modal("Nouvelle clé API",`<form id="p2Form" data-kind="api-key"><label>Nom<input name="name" required></label><label>Entreprise<select name="company"><option value="">Toutes autorisées</option>${companies.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label><fieldset><legend>Permissions</legend>${["summary:read","projects:read","clients:read"].map(x=>`<label class="p2-check"><input type="checkbox" name="scopes" value="${x}"> ${x}</label>`).join("")}</fieldset><button class="btn primary" type="submit">Créer</button></form>`);
  }

  document.addEventListener("click", async(e)=>{
    const tab=e.target.closest("[data-p2-tab]");
    if(tab){active=tab.dataset.p2Tab; const shell=tab.closest(".p2-center"); shell.querySelector(".p2-tabs").outerHTML=tabs(); host=shell.querySelector("#p2Body"); return renderCurrent();}
    const b=e.target.closest("[data-p2-action]"); if(!b)return;
    try{
      const a=b.dataset.p2Action;
      if(a==="readability"){window.SGOP2Runtime.setHighReadability(!window.SGOP2Runtime.highReadability());await renderCurrent();}
      else if(a==="tablet"){window.SGOP2Runtime.setTabletMode(!window.SGOP2Runtime.tabletMode());await renderCurrent();}
      else if(a==="sync"){const out=await window.SGOP2Runtime.flushQueue();core().toast(`Synchronisation : ${out.sent} envoyée(s), ${out.remaining} restante(s).`);await renderCurrent();}
      else if(a==="install"){await window.SGOP2Runtime.installApp();await renderCurrent();}
      else if(a==="appointment-new")appointmentForm();
      else if(a==="approval-new")approvalForm();
      else if(a==="approval-decide"){await api("approvals/"+b.dataset.id+"/decision",{status:b.dataset.status});await renderCurrent();}
      else if(a==="appointment-decision"){await api("appointments/"+b.dataset.id+"/decision",{status:b.dataset.status});await renderCurrent();}
      else if(a==="quote-remind"){await api("quote-reminders/"+b.dataset.id,{channel:b.dataset.channel});core().toast("Relance enregistrée.");}
      else if(a==="template-install"){await api("automation-templates/"+b.dataset.id+"/install",{});core().toast("Automatisation installée.");}
      else if(a==="permission-edit")permissionForm(b.dataset.id);
      else if(a==="api-key-new")apiKeyForm();
      else if(a==="api-key-revoke"){await api("api-keys/"+b.dataset.id+"/revoke",{});await renderCurrent();}
    }catch(err){core().notice(err.message);}
  });
  document.addEventListener("submit",async(e)=>{
    const f=e.target;if(f.id!=="p2Form")return;e.preventDefault();
    const fd=new FormData(f), p=Object.fromEntries(fd);
    try{
      if(f.dataset.kind==="appointment") await api("appointments",{...p,clientId:p.clientId||profile().client_id});
      else if(f.dataset.kind==="approval") await api("approvals",p);
      else if(f.dataset.kind==="permission") await api("permissions",{userId:Number(p.userId),grants:fd.getAll("grants"),denials:fd.getAll("denials")});
      else if(f.dataset.kind==="api-key"){
        const out=await api("api-keys",{name:p.name,company:p.company||null,scopes:fd.getAll("scopes")});
        core().closeModal(true);
        modal("Clé API créée",`<p>Copiez cette clé maintenant. Elle ne sera plus affichée.</p><pre class="p2-api-key">${esc(out.key)}</pre><button class="btn primary" type="button" data-action="close-modal">Fermer</button>`);
        await renderCurrent(); return;
      }
      core().closeModal(true);core().toast("Enregistré.");await renderCurrent();
    }catch(err){const x=document.getElementById("formError");if(x)x.textContent=err.message;else core().notice(err.message);}
  });
  window.addEventListener("sgo-offline-queue-change",()=>{if(host&&active==="overview")renderCurrent();});
  window.SGOP2Center={render};
})();
