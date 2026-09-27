"use strict";
(() => {
  let area = "overview",
    projectId = "",
    loadedDashboard = false,
    observer = null,
    cache = {};

  const core = () => window.SGOChatCore;
  const state = () => core()?.getState?.() || {};
  const profile = () => core()?.getProfile?.() || {};
  const esc = (v) => core()?.esc?.(v) ?? String(v ?? "").replace(/[&<>"']/g, "");
  const api = (path, body) => core().api("p1/" + path, body);
  const opsApi = (path, body) => core().api("operations/" + path, body);
  const money = (v) => new Intl.NumberFormat("fr-CH",{style:"currency",currency:"CHF"}).format(Number(v)||0);
  const date = (v) => v ? new Date(String(v).length===10?v+"T12:00:00":v).toLocaleDateString("fr-CH") : "—";
  const staff = () => ["admin","direction","hr","manager","accounting"].includes(profile().role);
  const operational = () => ["admin","direction","manager","accounting","employee"].includes(profile().role);
  const finance = () => ["admin","direction","accounting"].includes(profile().role);
  const direction = () => ["admin","direction"].includes(profile().role);
  const hr = () => ["admin","direction","hr"].includes(profile().role);
  const companies = () => (state().companies||[]).filter((x)=>x.id!=="group");
  const projects = () => state().projects||[];
  const employees = () => (state().employees||[]).filter((x)=>!x.deletedAt);
  const clients = () => state().clients||[];
  const inventory = () => state().inventory||[];
  const suppliers = () => state().suppliers||[];
  const tools = () => state().tools||[];
  const vehicles = () => state().vehicles||[];

  const I18N = {
    en: {
      "Tableau de bord":"Dashboard","Entreprises":"Companies","Salariés et comptes":"Employees & accounts","Heures":"Hours","Planning":"Schedule","Absences":"Absences","Chantiers":"Projects","Clients":"Clients","Devis":"Quotes","Factures":"Invoices","Paiements":"Payments","Dépenses":"Expenses","Matériel":"Inventory","Fournisseurs":"Suppliers","Véhicules":"Vehicles","Outillage":"Tools","Maintenance":"Maintenance","Documents":"Documents","Messages":"Messages","Rapports":"Reports","Pilotage":"Operations","Comptes":"Accounts","Journal":"Audit log","Mon compte":"My account","Déconnexion":"Sign out","Actualiser":"Refresh","Bienvenue":"Welcome","Se connecter":"Sign in","Mot de passe":"Password","E-mail":"Email","Mon pointage":"My time clock","Commencer":"Start","Pause":"Pause","Reprendre":"Resume","Terminer":"Stop","Modifier":"Edit","Supprimer":"Delete","Créer":"Create","Enregistrer":"Save","Annuler":"Cancel","Ouvrir":"Open","Ajouter":"Add","Nouveau":"New","En cours":"In progress","Terminé":"Done","Planifié":"Planned","À faire":"To do","Bloqué":"Blocked","Notifications":"Notifications","Recherche":"Search"
    },
    de: {
      "Tableau de bord":"Dashboard","Entreprises":"Unternehmen","Salariés et comptes":"Mitarbeitende & Konten","Heures":"Stunden","Planning":"Planung","Absences":"Abwesenheiten","Chantiers":"Projekte","Clients":"Kunden","Devis":"Offerten","Factures":"Rechnungen","Paiements":"Zahlungen","Dépenses":"Ausgaben","Matériel":"Material","Fournisseurs":"Lieferanten","Véhicules":"Fahrzeuge","Outillage":"Werkzeuge","Maintenance":"Wartung","Documents":"Dokumente","Messages":"Nachrichten","Rapports":"Berichte","Pilotage":"Steuerung","Comptes":"Konten","Journal":"Protokoll","Mon compte":"Mein Konto","Déconnexion":"Abmelden","Actualiser":"Aktualisieren","Bienvenue":"Willkommen","Se connecter":"Anmelden","Mot de passe":"Passwort","E-mail":"E-Mail","Mon pointage":"Meine Zeiterfassung","Commencer":"Starten","Pause":"Pause","Reprendre":"Fortsetzen","Terminer":"Beenden","Modifier":"Bearbeiten","Supprimer":"Löschen","Créer":"Erstellen","Enregistrer":"Speichern","Annuler":"Abbrechen","Ouvrir":"Öffnen","Ajouter":"Hinzufügen","Nouveau":"Neu","En cours":"In Arbeit","Terminé":"Erledigt","Planifié":"Geplant","À faire":"Zu tun","Bloqué":"Blockiert","Notifications":"Benachrichtigungen","Recherche":"Suche"
    },
    it: {
      "Tableau de bord":"Dashboard","Entreprises":"Aziende","Salariés et comptes":"Dipendenti e account","Heures":"Ore","Planning":"Pianificazione","Absences":"Assenze","Chantiers":"Cantieri","Clients":"Clienti","Devis":"Preventivi","Factures":"Fatture","Paiements":"Pagamenti","Dépenses":"Spese","Matériel":"Materiale","Fournisseurs":"Fornitori","Véhicules":"Veicoli","Outillage":"Attrezzatura","Maintenance":"Manutenzione","Documents":"Documenti","Messages":"Messaggi","Rapports":"Rapporti","Pilotage":"Gestione","Comptes":"Account","Journal":"Registro","Mon compte":"Il mio account","Déconnexion":"Disconnetti","Actualiser":"Aggiorna","Bienvenue":"Benvenuto","Se connecter":"Accedi","Mot de passe":"Password","E-mail":"E-mail","Mon pointage":"La mia timbratura","Commencer":"Inizia","Pause":"Pausa","Reprendre":"Riprendi","Terminer":"Termina","Modifier":"Modifica","Supprimer":"Elimina","Créer":"Crea","Enregistrer":"Salva","Annuler":"Annulla","Ouvrir":"Apri","Ajouter":"Aggiungi","Nouveau":"Nuovo","En cours":"In corso","Terminé":"Terminato","Planifié":"Pianificato","À faire":"Da fare","Bloqué":"Bloccato","Notifications":"Notifiche","Recherche":"Ricerca"
    },
    pt: {
      "Tableau de bord":"Painel","Entreprises":"Empresas","Salariés et comptes":"Funcionários e contas","Heures":"Horas","Planning":"Planeamento","Absences":"Ausências","Chantiers":"Obras","Clients":"Clientes","Devis":"Orçamentos","Factures":"Faturas","Paiements":"Pagamentos","Dépenses":"Despesas","Matériel":"Material","Fournisseurs":"Fornecedores","Véhicules":"Veículos","Outillage":"Ferramentas","Maintenance":"Manutenção","Documents":"Documentos","Messages":"Mensagens","Rapports":"Relatórios","Pilotage":"Gestão","Comptes":"Contas","Journal":"Registo","Mon compte":"Minha conta","Déconnexion":"Sair","Actualiser":"Atualizar","Bienvenue":"Bem-vindo","Se connecter":"Entrar","Mot de passe":"Palavra-passe","E-mail":"E-mail","Mon pointage":"Meu ponto","Commencer":"Iniciar","Pause":"Pausa","Reprendre":"Retomar","Terminer":"Terminar","Modifier":"Editar","Supprimer":"Eliminar","Créer":"Criar","Enregistrer":"Guardar","Annuler":"Cancelar","Ouvrir":"Abrir","Ajouter":"Adicionar","Nouveau":"Novo","En cours":"Em curso","Terminé":"Concluído","Planifié":"Planeado","À faire":"A fazer","Bloqué":"Bloqueado","Notifications":"Notificações","Recherche":"Pesquisa"
    },
    es: {
      "Tableau de bord":"Panel","Entreprises":"Empresas","Salariés et comptes":"Empleados y cuentas","Heures":"Horas","Planning":"Planificación","Absences":"Ausencias","Chantiers":"Obras","Clients":"Clientes","Devis":"Presupuestos","Factures":"Facturas","Paiements":"Pagos","Dépenses":"Gastos","Matériel":"Material","Fournisseurs":"Proveedores","Véhicules":"Vehículos","Outillage":"Herramientas","Maintenance":"Mantenimiento","Documents":"Documentos","Messages":"Mensajes","Rapports":"Informes","Pilotage":"Gestión","Comptes":"Cuentas","Journal":"Registro","Mon compte":"Mi cuenta","Déconnexion":"Cerrar sesión","Actualiser":"Actualizar","Bienvenue":"Bienvenido","Se connecter":"Entrar","Mot de passe":"Contraseña","E-mail":"Correo","Mon pointage":"Mi fichaje","Commencer":"Iniciar","Pause":"Pausa","Reprendre":"Reanudar","Terminer":"Terminar","Modifier":"Editar","Supprimer":"Eliminar","Créer":"Crear","Enregistrer":"Guardar","Annuler":"Cancelar","Ouvrir":"Abrir","Ajouter":"Añadir","Nouveau":"Nuevo","En cours":"En curso","Terminé":"Terminado","Planifié":"Planificado","À faire":"Por hacer","Bloqué":"Bloqueado","Notifications":"Notificaciones","Recherche":"Buscar"
    },
    sq: {
      "Tableau de bord":"Paneli","Entreprises":"Kompanitë","Salariés et comptes":"Punonjësit dhe llogaritë","Heures":"Orët","Planning":"Planifikimi","Absences":"Mungesat","Chantiers":"Projektet","Clients":"Klientët","Devis":"Ofertat","Factures":"Faturat","Paiements":"Pagesat","Dépenses":"Shpenzimet","Matériel":"Materiali","Fournisseurs":"Furnitorët","Véhicules":"Automjetet","Outillage":"Veglat","Maintenance":"Mirëmbajtja","Documents":"Dokumentet","Messages":"Mesazhet","Rapports":"Raportet","Pilotage":"Menaxhimi","Comptes":"Llogaritë","Journal":"Regjistri","Mon compte":"Llogaria ime","Déconnexion":"Dil","Actualiser":"Përditëso","Bienvenue":"Mirë se vini","Se connecter":"Hyr","Mot de passe":"Fjalëkalimi","E-mail":"E-mail","Mon pointage":"Regjistrimi im","Commencer":"Fillo","Pause":"Pauzë","Reprendre":"Vazhdo","Terminer":"Përfundo","Modifier":"Ndrysho","Supprimer":"Fshi","Créer":"Krijo","Enregistrer":"Ruaj","Annuler":"Anulo","Ouvrir":"Hap","Ajouter":"Shto","Nouveau":"I ri","En cours":"Në proces","Terminé":"Përfunduar","Planifié":"Planifikuar","À faire":"Për t'u bërë","Bloqué":"Bllokuar","Notifications":"Njoftimet","Recherche":"Kërko"
    }
  };
  function language(){ return window.SGOAccountPreferences?.language || "fr"; }
  function translateDom(){
    const lang=language(), dict=I18N[lang];
    if(!dict) return;
    const root=document.querySelector("#app:not(.hidden), #login:not(.hidden)") || document.body;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let node;
    while((node=walker.nextNode())){
      if(node.parentElement?.closest("script,style,textarea,input,option")) continue;
      const raw=node.nodeValue, key=raw.trim();
      if(dict[key]) node.nodeValue=raw.replace(key,dict[key]);
    }
    for(const el of root.querySelectorAll("[aria-label],[title],[placeholder]")){
      for(const attr of ["aria-label","title","placeholder"]){
        const v=el.getAttribute(attr); if(v&&dict[v]) el.setAttribute(attr,dict[v]);
      }
    }
  }
  function watchTranslations(){
    if(observer) return;
    observer=new MutationObserver(()=>queueMicrotask(translateDom));
    observer.observe(document.body,{subtree:true,childList:true});
    translateDom();
  }

  function option(list, valueKey="id", labelKey="name", selected=""){
    return list.map((x)=>`<option value="${esc(x[valueKey])}" ${String(x[valueKey])===String(selected)?"selected":""}>${esc(x[labelKey]||x[valueKey])}</option>`).join("");
  }
  function companyOptions(selected=""){ return option(companies(),"id","name",selected); }
  function projectOptions(selected=""){ return option(projects(),"id","title",selected); }
  function employeeOptions(selected=""){ return '<option value="">—</option>'+option(employees(),"id","name",selected); }
  function clientOptions(selected=""){ return option(clients(),"id","name",selected); }
  function inventoryOptions(selected=""){ return option(inventory(),"id","name",selected); }
  function supplierOptions(selected=""){ return option(suppliers(),"id","name",selected); }
  function toolOptions(selected=""){ return option(tools(),"id","name",selected); }
  function vehicleOptions(selected=""){ return option(vehicles(),"id","plate",selected); }
  function btn(label,action,attrs="",kind=""){ return `<button type="button" class="btn ${kind}" data-p1-action="${esc(action)}" ${attrs}>${esc(label)}</button>`; }
  function card(title,body,actions=""){ return `<article class="card p1-card"><div class="p1-card-head"><h3>${esc(title)}</h3><div>${actions}</div></div>${body}</article>`; }
  function tabs(){
    const items=[
      ["overview","P1 · État"],
      ["project","Chantier+"],
      ...(hr()||profile().role==="employee"?[["time","Pointage+"]]:[]),
      ...(finance()?[["finance","Finance+"]]:[]),
      ...(operational()?[["procurement","Achats & stock"],["assets","Parc & outillage"],["maintenance","Maintenance+"]]:[]),
      ...(direction()?[["integrations","Connecteurs"]]:[])
    ];
    return `<div class="p1-tabs">${items.map(([id,l])=>`<button type="button" data-p1-area="${id}" class="${area===id?"active":""}">${esc(l)}</button>`).join("")}</div>`;
  }
  function shell(body){ return `<section id="p1Suite" class="p1-suite">${tabs()}<div id="p1Body">${body}</div></section>`; }

  async function renderOverview(root){
    const status=await api("status");
    const external=status.external||{};
    const body=`
      <div class="p1-kpis">
        <article><b>✓</b><span>Recherche, notifications, Kanban, RH, paie</span></article>
        <article><b>✓</b><span>Jalons, sous-tâches, chantier opérationnel</span></article>
        <article><b>✓</b><span>Finance récurrente, avoirs, relances, lien paiement</span></article>
        <article><b>✓</b><span>Achats, dépôts, QR/barcodes, parc véhicules/outillage</span></article>
      </div>
      ${card("P1 opérationnel",`<p>Les modules P1 sont centralisés ici. Les fonctions externes restent activables dès que leurs identifiants API sont configurés côté serveur.</p>
      <div class="p1-status-grid">
        ${Object.entries(external).map(([k,v])=>`<div class="${v?"ready":"pending"}"><span>${v?"✓":"!"}</span><b>${esc(k.toUpperCase())}</b><small>${v?"API configurée":"Identifiants externes requis"}</small></div>`).join("")}
      </div>`)}
      ${direction()?card("Automatisations","`Factures récurrentes, interventions de maintenance et relances J+7/J+14/J+30 sont exécutées par le serveur.`",btn("Exécuter maintenant","run-jobs","","primary")):""}
    `;
    root.querySelector("#p1Body").innerHTML=body;
  }

  async function renderProject(root){
    if(!projectId) projectId=projects()[0]?.id||"";
    if(!projectId){ root.querySelector("#p1Body").innerHTML=card("Chantier+","<p>Aucun chantier accessible.</p>"); return; }
    const out=await api("project/"+encodeURIComponent(projectId)+"/full");
    cache.project=out;
    const p=out.project||{};
    const clock=(state().clocks||[])[0];
    const quickClock=profile().employee_id ? (clock
      ? btn("Terminer le pointage","quick-clock-stop",`data-project="${esc(clock.project)}"`,"danger")
      : btn("Commencer sur ce chantier","quick-clock-start",`data-project="${esc(projectId)}"`,"primary")) : "";
    root.querySelector("#p1Body").innerHTML=`
      <div class="p1-toolbar"><label>Chantier<select id="p1ProjectSelect">${projectOptions(projectId)}</select></label><div>${quickClock} ${btn("Historique complet","project-history")}</div></div>
      <div class="p1-grid-2">
        ${card("Jalons",`<div class="p1-list">${(out.milestones||[]).map(x=>`<div><span><b>${esc(x.title)}</b><small>${esc(x.status)} · ${date(x.due_date)}</small></span>${operational()?btn("Supprimer","delete-milestone",`data-id="${esc(x.id)}"`,"danger"):""}</div>`).join("")||"<p>Aucun jalon.</p>"}</div>`,operational()?btn("Ajouter","new-milestone","","primary"):"")}
        ${card("Tâches & sous-tâches",`<div class="p1-list">${(out.tasks||[]).map(x=>`<div class="${x.parent_task_id?"p1-subtask":""}"><span><b>${x.parent_task_id?"↳ ":""}${esc(x.title)}</b><small>${esc(x.status)} · ${date(x.due_date)}</small></span>${!x.parent_task_id&&operational()?btn("Sous-tâche","new-subtask",`data-parent="${esc(x.id)}"`):""}</div>`).join("")||"<p>Aucune tâche.</p>"}</div>`)}
        ${card("Checklist",`<div class="p1-list">${(out.checklist||[]).map(x=>`<label class="p1-check"><input type="checkbox" data-p1-checklist="${esc(x.id)}" ${x.completed?"checked":""}> <span>${esc(x.label)}</span></label>`).join("")||"<p>Aucun contrôle.</p>"}</div>`,operational()?btn("Ajouter","new-checklist","","primary"):"")}
        ${card("Rapports journaliers",`<div class="p1-list">${(out.reports||[]).slice(0,8).map(x=>`<div><span><b>${date(x.report_date)}</b><small>${esc(x.summary)}</small></span></div>`).join("")||"<p>Aucun rapport.</p>"}</div>`,operational()?btn("Nouveau rapport","new-report","","primary"):"")}
        ${card("Réserves",`<div class="p1-list">${(out.punch||[]).map(x=>`<div><span><b>${esc(x.title)}</b><small>${esc(x.severity)} · ${esc(x.status)} · ${date(x.due_date)}</small></span></div>`).join("")||"<p>Aucune réserve.</p>"}</div>`,operational()?btn("Ajouter","new-punch","","primary"):"")}
        ${card("Plus-values",`<div class="p1-list">${(out.changeOrders||[]).map(x=>`<div><span><b>${esc(x.title)} · ${money(x.amount)}</b><small>${esc(x.status)}</small></span></div>`).join("")||"<p>Aucune plus-value.</p>"}</div>`,operational()?btn("Ajouter","new-change-order","","primary"):"")}
        ${card("Albums & annotations photo",`<div class="p1-list">${(out.photos||[]).map(x=>`<div><span><b>${esc(x.album)}</b><small>${esc(x.note||"")} · ${Array.isArray(x.annotation)?x.annotation.length:0} annotation(s)</small></span></div>`).join("")||"<p>Aucune annotation.</p>"}</div>`,operational()?btn("Annoter / classer","new-photo-meta","","primary"):"")}
        ${card("QR chantier",`<div class="p1-qr-code"><code>${esc(p.id)}</code></div><p>Le numéro chantier sert d’identifiant QR. Scannez un code pour ouvrir directement le chantier correspondant.</p>`,btn("Scanner un QR","scan-project"))}
      </div>`;
  }

  async function renderTime(root){
    const selectedCompany=cache.timeCompany||companies()[0]?.id||"";
    if(!selectedCompany){ root.querySelector("#p1Body").innerHTML=card("Pointage+","<p>Aucune entreprise.</p>");return; }
    const [policy,summary]=await Promise.all([
      api("time/policy?company="+encodeURIComponent(selectedCompany)),
      api("time/summary?month="+encodeURIComponent(new Date().toISOString().slice(0,7)))
    ]);
    cache.timePolicy=policy.policy;
    root.querySelector("#p1Body").innerHTML=`
      <div class="p1-toolbar"><label>Entreprise<select id="p1TimeCompany">${companyOptions(selectedCompany)}</select></label></div>
      <div class="p1-grid-2">
        ${card("Règles de pointage",`<form id="p1Form" data-kind="time-policy">
          <input type="hidden" name="company" value="${esc(selectedCompany)}">
          <label>Pause automatique après (heures)<input type="number" step="0.25" min="0" max="24" name="autoBreakAfterHours" value="${esc(policy.policy.auto_break_after_hours??6)}"></label>
          <label>Pause minimale (minutes)<input type="number" min="0" max="240" name="autoBreakMinutes" value="${esc(policy.policy.auto_break_minutes??30)}"></label>
          <label class="p1-check"><input type="checkbox" name="geolocationEnabled" ${policy.policy.geolocation_enabled?"checked":""}> Géolocalisation facultative lors du pointage</label>
          <label>Jours fériés (AAAA-MM-JJ, séparés par virgules)<textarea name="holidayDates">${esc((policy.policy.holiday_dates||[]).join(", "))}</textarea></label>
          <button class="btn primary" type="submit">Enregistrer</button>
        </form><p class="muted">La position n’est enregistrée que si cette option est active et si le salarié autorise la localisation sur son appareil.</p>`)}
        ${card("Synthèse du mois",`<div class="p1-list">${(summary.rows||[]).map(x=>`<div><span><b>${esc(x.name)}</b><small>Total ${esc(x.total)} h · Jours fériés ${esc(x.holiday)} h</small></span></div>`).join("")||"<p>Aucune heure ce mois.</p>"}</div>`)}
      </div>`;
  }

  async function renderFinance(root){
    const out=await api("finance"); cache.finance=out;
    root.querySelector("#p1Body").innerHTML=`
      <div class="p1-actions">${btn("Modèle devis","finance-template","","primary")} ${btn("Prestation / prix","finance-catalog")} ${btn("Prix client","client-pricing")} ${btn("Facture récurrente","recurring-invoice")} ${btn("Avoir","credit-note")} ${btn("Lien paiement","payment-link")} ${btn("Lancer relances","run-reminders")}</div>
      <div class="p1-grid-2">
        ${card("Modèles de devis",`<div class="p1-list">${(out.templates||[]).map(x=>`<div><span><b>${esc(x.name)}</b><small>${esc(x.company)} · ${x.lines?.length||0} ligne(s)</small></span></div>`).join("")||"<p>Aucun modèle.</p>"}</div>`)}
        ${card("Catalogue prestations / prix",`<div class="p1-list">${(out.catalog||[]).map(x=>`<div><span><b>${esc(x.name)}</b><small>${esc(x.sku||"")} · ${money(x.price)} / ${esc(x.unit)}</small></span></div>`).join("")||"<p>Aucune prestation.</p>"}</div>`)}
        ${card("Factures récurrentes",`<div class="p1-list">${(out.recurring||[]).map(x=>`<div><span><b>${esc(x.title)}</b><small>${esc(x.frequency)} · prochaine ${date(x.next_run)} · ${x.active?"active":"inactive"}</small></span></div>`).join("")||"<p>Aucune récurrence.</p>"}</div>`)}
        ${card("Avoirs",`<div class="p1-list">${(out.credits||[]).map(x=>`<div><span><b>${esc(x.number)} · ${money(x.amount)}</b><small>${esc(x.invoice_id)} · ${esc(x.reason)}</small></span></div>`).join("")||"<p>Aucun avoir.</p>"}</div>`)}
        ${card("Relances automatiques",`<div class="p1-list">${(out.reminders||[]).slice(0,30).map(x=>`<div><span><b>${esc(x.invoice_id)} · J+${esc(x.stage)}</b><small>${money(x.amount_due)} · ${date(x.created_at)}</small></span></div>`).join("")||"<p>Aucune relance générée.</p>"}</div>`)}
        ${card("Liens de paiement",`<div class="p1-list">${(out.links||[]).map(x=>`<div><span><b>${esc(x.invoice_id)}</b><small>Expire ${date(x.expires_at)} · ${x.active?"actif":"inactif"}</small></span></div>`).join("")||"<p>Aucun lien.</p>"}</div>`)}
      </div>`;
  }

  async function renderProcurement(root){
    const out=await api("procurement"); cache.procurement=out;
    root.querySelector("#p1Body").innerHTML=`
      <div class="p1-actions">${btn("Nouveau dépôt","new-location","","primary")} ${btn("Commande fournisseur","new-order")} ${btn("Associer code-barres / QR","new-barcode")} ${btn("Scanner article","scan-item")}</div>
      <div class="p1-grid-2">
        ${card("Dépôts",`<div class="p1-list">${(out.locations||[]).map(x=>`<div><span><b>${esc(x.name)}</b><small>${esc(x.company)} · ${esc(x.type)}</small></span></div>`).join("")||"<p>Aucun dépôt.</p>"}</div>`)}
        ${card("Commandes fournisseurs",`<div class="p1-list">${(out.orders||[]).map(x=>`<div><span><b>${esc(x.supplier_name)} · ${money(x.total)}</b><small>${esc(x.status)} · prévu ${date(x.expected_at)}</small></span></div>`).join("")||"<p>Aucune commande.</p>"}</div>`)}
        ${card("Codes article",`<div class="p1-list">${(out.barcodes||[]).map(x=>`<div><span><b>${esc(inventory().find(i=>String(i.id)===String(x.inventory_id))?.name||x.inventory_id)}</b><small><code>${esc(x.code)}</code></small></span></div>`).join("")||"<p>Aucun code associé.</p>"}</div>`)}
        ${card("Stock minimum",`<div class="p1-list">${inventory().filter(x=>Number(x.min)>0&&Number(x.stock)<=Number(x.min)).map(x=>`<div><span><b>${esc(x.name)}</b><small>Stock ${esc(x.stock)} · minimum ${esc(x.min)}</small></span></div>`).join("")||"<p>Aucune alerte stock.</p>"}</div>`)}
      </div>`;
  }

  async function renderAssets(root){
    const out=await api("assets"); cache.assets=out;
    root.querySelector("#p1Body").innerHTML=`
      <div class="p1-actions">${btn("Événement outillage","tool-event","","primary")} ${btn("Événement véhicule / dommage","vehicle-event")}</div>
      <div class="p1-grid-2">
        ${card("Historique outillage",`<div class="p1-list">${(out.toolEvents||[]).map(x=>`<div><span><b>${esc(tools().find(t=>String(t.id)===String(x.tool_id))?.name||x.tool_id)}</b><small>${esc(x.event_type)} · ${esc(x.note||"")} · ${date(x.created_at)}</small></span></div>`).join("")||"<p>Aucun événement.</p>"}</div>`)}
        ${card("Historique véhicules",`<div class="p1-list">${(out.vehicleEvents||[]).map(x=>`<div><span><b>${esc(vehicles().find(v=>String(v.id)===String(x.vehicle_id))?.plate||x.vehicle_id)}</b><small>${esc(x.event_type)} · ${esc(x.note||"")} · ${date(x.event_date)}</small></span></div>`).join("")||"<p>Aucun événement.</p>"}</div>`)}
      </div>`;
  }

  async function renderMaintenance(root){
    const out=await api("maintenance"); cache.maintenance=out;
    root.querySelector("#p1Body").innerHTML=`
      <div class="p1-actions">${btn("Nouveau plan récurrent","maintenance-plan","","primary")}</div>
      ${card("Contrats & interventions automatiques",`<div class="p1-list">${(out.plans||[]).map(x=>`<div><span><b>${esc(x.title)}</b><small>${esc(x.frequency)} · prochaine ${date(x.next_run)} · SLA ${esc(x.sla_hours||"—")} h · ${x.auto_invoice?"facturation auto":"facturation manuelle"}</small></span></div>`).join("")||"<p>Aucun plan.</p>"}</div><p class="muted">À l’échéance, une intervention est créée automatiquement. La facture automatique est disponible uniquement lorsqu’elle a été activée par un rôle comptable.</p>`)}
    `;
  }

  async function renderIntegrations(root){
    const out=await api("integrations"); cache.integrations=out;
    const providers=["ebill","banking","bexio","abacus","winbiz","email","sms"];
    root.querySelector("#p1Body").innerHTML=`
      ${card("Connecteurs externes",`<div class="p1-status-grid">${providers.map(p=>{const cfg=(out.profiles||[]).find(x=>x.provider===p);const runtime=out.runtime?.[p];return `<button type="button" data-p1-action="integration" data-provider="${p}" class="${runtime&&cfg?.enabled?"ready":"pending"}"><span>${runtime&&cfg?.enabled?"✓":"!"}</span><b>${p.toUpperCase()}</b><small>${runtime?"clé serveur présente":"clé/API externe requise"} · ${cfg?.enabled?"activé":"désactivé"}</small></button>`}).join("")}</div><p class="muted">Les secrets ne sont jamais saisis ni stockés dans l’interface. Ils doivent être configurés comme variables d’environnement du serveur.</p>`)}
    `;
  }

  async function renderInto(root){
    if(!root) return;
    root.innerHTML=shell('<article class="card"><p>Chargement P1…</p></article>');
    try{
      if(area==="overview") await renderOverview(root);
      else if(area==="project") await renderProject(root);
      else if(area==="time") await renderTime(root);
      else if(area==="finance") await renderFinance(root);
      else if(area==="procurement") await renderProcurement(root);
      else if(area==="assets") await renderAssets(root);
      else if(area==="maintenance") await renderMaintenance(root);
      else if(area==="integrations") await renderIntegrations(root);
    }catch(e){
      root.querySelector("#p1Body").innerHTML=card("Erreur",`<p>${esc(e.message)}</p>`);
    }
    translateDom();
  }

  function modal(title,html){ core().modal(title,html); }
  function lineEditor(){
    return `<fieldset><legend>Prestation</legend><label>Description<input name="description" required></label><label>Quantité<input type="number" step="0.001" min="0.001" name="quantity" value="1"></label><label>Unité<input name="unit" value="pcs"></label><label>Prix CHF<input type="number" step="0.01" min="0" name="unitPrice" value="0"></label><label>Remise %<input type="number" step="0.01" min="0" max="100" name="discount" value="0"></label><label>TVA %<input type="number" step="0.01" min="0" max="100" name="vatRate" value="0"></label></fieldset>`;
  }
  function singleLine(form){
    return [{description:form.description.value,quantity:Number(form.quantity.value),unit:form.unit.value,unitPrice:Number(form.unitPrice.value),discount:Number(form.discount.value),vatRate:Number(form.vatRate.value)}];
  }
  function openForm(kind,attrs={}){
    if(kind==="milestone") modal("Nouveau jalon",`<form id="p1Form" data-kind="milestone"><label>Titre<input name="title" required></label><label>Échéance<input type="date" name="dueDate"></label><label>Statut<select name="status"><option value="planned">Planifié</option><option value="in_progress">En cours</option><option value="blocked">Bloqué</option><option value="done">Terminé</option></select></label><label>Notes<textarea name="notes"></textarea></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="subtask") modal("Nouvelle sous-tâche",`<form id="p1Form" data-kind="subtask"><input type="hidden" name="parentTaskId" value="${esc(attrs.parent||"")}"><label>Titre<input name="title" required></label><label>Description<textarea name="description"></textarea></label><label>Priorité<select name="priority"><option>normal</option><option>high</option><option>urgent</option><option>low</option></select></label><label>Salarié<select name="assignedEmployeeId">${employeeOptions()}</select></label><label>Échéance<input type="date" name="dueDate"></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="checklist") modal("Ajouter un contrôle",`<form id="p1Form" data-kind="checklist"><label>Contrôle<input name="label" required></label><button class="btn primary" type="submit">Ajouter</button></form>`);
    else if(kind==="report") modal("Rapport journalier",`<form id="p1Form" data-kind="report"><label>Date<input type="date" name="reportDate" value="${new Date().toISOString().slice(0,10)}" required></label><label>Météo<input name="weather"></label><label>Résumé<textarea name="summary" required></textarea></label><label>Problèmes<textarea name="issues"></textarea></label><label>Matériel<textarea name="materials"></textarea></label><label>Équipe<textarea name="team"></textarea></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="punch") modal("Nouvelle réserve",`<form id="p1Form" data-kind="punch"><label>Titre<input name="title" required></label><label>Description<textarea name="description"></textarea></label><label>Sévérité<select name="severity"><option>normal</option><option>high</option><option>critical</option><option>low</option></select></label><label>Échéance<input type="date" name="dueDate"></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="change-order") modal("Nouvelle plus-value",`<form id="p1Form" data-kind="change-order"><label>Titre<input name="title" required></label><label>Description<textarea name="description"></textarea></label><label>Montant CHF<input type="number" min="0" step="0.01" name="amount" required></label><label>Statut<select name="status"><option value="draft">Brouillon</option><option value="sent">Envoyée</option></select></label><label>Note client<textarea name="clientNote"></textarea></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="photo-meta") modal("Classer / annoter une photo",`<form id="p1Form" data-kind="photo-meta"><label>ID du document/photo<input name="documentId" placeholder="ID du document existant"></label><label>Album<select name="album"><option value="avant">Avant</option><option value="pendant">Pendant</option><option value="apres">Après</option><option value="reserve">Réserve</option><option value="autre">Autre</option></select></label><label>Note<textarea name="note"></textarea></label><label>Annotation texte / flèche<textarea name="annotationText" placeholder="Ex. Flèche : prise à déplacer de 20 cm"></textarea></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="finance-template") modal("Modèle de devis",`<form id="p1Form" data-kind="finance-template"><label>Entreprise<select name="company">${companyOptions()}</select></label><label>Nom<input name="name" required></label><label>Titre<input name="title"></label>${lineEditor()}<button class="btn primary" type="submit">Créer</button></form>`);
    else if(kind==="finance-catalog") modal("Prestation / prix",`<form id="p1Form" data-kind="finance-catalog"><label>Entreprise<select name="company">${companyOptions()}</select></label><label>Référence<input name="sku"></label><label>Nom<input name="name" required></label><label>Catégorie<input name="category"></label><label>Unité<input name="unit" value="h"></label><label>Prix CHF<input type="number" min="0" step="0.01" name="price" required></label><label>TVA %<input type="number" min="0" max="100" step="0.01" name="vatRate" value="0"></label><button class="btn primary" type="submit">Créer</button></form>`);
    else if(kind==="client-pricing") modal("Conditions client",`<form id="p1Form" data-kind="client-pricing"><label>Client<select name="clientId">${clientOptions()}</select></label><label>Remise %<input type="number" min="0" max="100" step="0.01" name="discountPct" value="0"></label><label>Délai paiement (jours)<input type="number" min="0" max="365" name="paymentDays" value="30"></label><label>Tarif / groupe<input name="priceTier"></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="recurring-invoice") modal("Facture récurrente",`<form id="p1Form" data-kind="recurring-invoice"><label>Client<select name="clientId">${clientOptions()}</select></label><label>Titre<input name="title" required></label><label>Fréquence<select name="frequency"><option value="monthly">Mensuelle</option><option value="quarterly">Trimestrielle</option><option value="yearly">Annuelle</option><option value="weekly">Hebdomadaire</option></select></label><label>Prochaine facture<input type="date" name="nextRun" required></label><label>Délai paiement<input type="number" name="paymentDays" value="30"></label>${lineEditor()}<button class="btn primary" type="submit">Créer</button></form>`);
    else if(kind==="credit-note") modal("Créer un avoir",`<form id="p1Form" data-kind="credit-note"><label>Facture<select name="invoiceId">${(cache.finance?.invoices||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.id)} · ${money(x.amount)}</option>`).join("")}</select></label><label>Montant CHF<input type="number" min="0.01" step="0.01" name="amount" required></label><label>Motif<textarea name="reason" required></textarea></label><button class="btn primary" type="submit">Émettre l’avoir</button></form>`);
    else if(kind==="payment-link") modal("Lien de paiement",`<form id="p1Form" data-kind="payment-link"><label>Facture<select name="invoiceId">${(cache.finance?.invoices||[]).filter(x=>x.status!=="Brouillon").map(x=>`<option value="${esc(x.id)}">${esc(x.id)} · ${money(x.amount)}</option>`).join("")}</select></label><label>Validité (jours)<input type="number" name="days" value="30" min="1" max="365"></label><button class="btn primary" type="submit">Créer le lien</button></form>`);
    else if(kind==="location") modal("Nouveau dépôt",`<form id="p1Form" data-kind="location"><label>Entreprise<select name="company">${companyOptions()}</select></label><label>Nom<input name="name" required></label><label>Type<select name="type"><option value="warehouse">Dépôt</option><option value="vehicle">Véhicule</option><option value="project">Chantier</option><option value="other">Autre</option></select></label><button class="btn primary" type="submit">Créer</button></form>`);
    else if(kind==="order") modal("Commande fournisseur",`<form id="p1Form" data-kind="order"><label>Fournisseur<select name="supplierId">${supplierOptions()}</select></label><label>Chantier<select name="projectId"><option value="">—</option>${projectOptions()}</select></label><label>Statut<select name="status"><option value="draft">Brouillon</option><option value="ordered">Commandée</option></select></label><label>Date commande<input type="date" name="orderedAt"></label><label>Livraison prévue<input type="date" name="expectedAt"></label>${lineEditor()}<button class="btn primary" type="submit">Créer</button></form>`);
    else if(kind==="barcode") modal("Associer un code article",`<form id="p1Form" data-kind="barcode"><label>Article<select name="inventoryId">${inventoryOptions()}</select></label><label>Code-barres / QR<input name="code" required></label><button class="btn primary" type="submit">Associer</button></form>`);
    else if(kind==="tool-event") modal("Événement outillage",`<form id="p1Form" data-kind="tool-event"><label>Outil<select name="toolId">${toolOptions()}</select></label><label>Événement<select name="eventType"><option value="assignment">Attribution</option><option value="return">Retour</option><option value="lost">Perdu</option><option value="broken">Cassé</option><option value="maintenance">Maintenance</option><option value="inspection">Contrôle</option></select></label><label>Salarié<select name="employeeId">${employeeOptions()}</select></label><label>Échéance<input type="date" name="dueDate"></label><label>Note<textarea name="note"></textarea></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="vehicle-event") modal("Événement véhicule",`<form id="p1Form" data-kind="vehicle-event"><label>Véhicule<select name="vehicleId">${vehicleOptions()}</select></label><label>Type<select name="eventType"><option value="service">Entretien</option><option value="tires">Pneus</option><option value="insurance">Assurance</option><option value="inspection">Expertise</option><option value="damage">Dommage</option><option value="km">Kilométrage</option><option value="assignment">Attribution</option></select></label><label>Date<input type="date" name="eventDate" value="${new Date().toISOString().slice(0,10)}"></label><label>Prochaine échéance<input type="date" name="dueDate"></label><label>Km<input type="number" min="0" name="km"></label><label>Description<textarea name="note"></textarea></label><button class="btn primary" type="submit">Enregistrer</button></form>`);
    else if(kind==="maintenance-plan") modal("Plan de maintenance récurrente",`<form id="p1Form" data-kind="maintenance-plan"><label>Client<select name="clientId">${clientOptions()}</select></label><label>Titre<input name="title" required></label><label>Fréquence<select name="frequency"><option value="monthly">Mensuelle</option><option value="quarterly">Trimestrielle</option><option value="yearly">Annuelle</option><option value="weekly">Hebdomadaire</option></select></label><label>Prochaine intervention<input type="date" name="nextRun" required></label><label>Priorité<select name="priority"><option>normal</option><option>high</option><option>urgent</option><option>low</option></select></label><label>SLA / délai max (heures)<input type="number" min="1" max="720" name="slaHours"></label>${finance()?`<label class="p1-check"><input type="checkbox" name="autoInvoice"> Facturer automatiquement</label><label>Délai paiement<input type="number" name="paymentDays" value="30"></label>${lineEditor()}`:""}<button class="btn primary" type="submit">Créer</button></form>`);
    else if(kind==="integration") modal("Connecteur "+String(attrs.provider||"").toUpperCase(),`<form id="p1Form" data-kind="integration"><input type="hidden" name="provider" value="${esc(attrs.provider||"")}"><label class="p1-check"><input type="checkbox" name="enabled"> Activer dans Sousa Group One</label><label>Mode<select name="mode"><option value="manual">Manuel</option><option value="export">Export</option><option value="api">API</option></select></label><label>Libellé<input name="label"></label><p class="muted">Aucun secret API n’est stocké ici. La clé doit être configurée côté serveur.</p><button class="btn primary" type="submit">Enregistrer</button></form>`);
  }

  async function submit(form){
    const fd=new FormData(form), p=Object.fromEntries(fd.entries()), kind=form.dataset.kind;
    try{
      if(kind==="time-policy"){
        p.autoBreakAfterHours=Number(p.autoBreakAfterHours); p.autoBreakMinutes=Number(p.autoBreakMinutes);
        p.geolocationEnabled=fd.get("geolocationEnabled")==="on";
        p.holidayDates=String(p.holidayDates||"").split(",").map(x=>x.trim()).filter(Boolean);
        await api("time/policy",p);
      }else if(kind==="milestone") await api("project/"+encodeURIComponent(projectId)+"/milestone",p);
      else if(kind==="subtask") await api("project/"+encodeURIComponent(projectId)+"/subtask",p);
      else if(kind==="checklist") await opsApi("project/"+encodeURIComponent(projectId)+"/checklist",p);
      else if(kind==="report") await opsApi("project/"+encodeURIComponent(projectId)+"/report",p);
      else if(kind==="punch") await opsApi("project/"+encodeURIComponent(projectId)+"/punch",p);
      else if(kind==="change-order"){p.amount=Number(p.amount);await opsApi("project/"+encodeURIComponent(projectId)+"/change-order",p);}
      else if(kind==="photo-meta"){p.annotation=p.annotationText?[{type:"arrow-note",text:p.annotationText}]:[];delete p.annotationText;await api("project/"+encodeURIComponent(projectId)+"/photo-meta",p);}
      else if(kind==="finance-template"){p.lines=singleLine(form);await api("finance/template",p);}
      else if(kind==="finance-catalog"){p.price=Number(p.price);p.vatRate=Number(p.vatRate);await api("finance/catalog",p);}
      else if(kind==="client-pricing"){p.discountPct=Number(p.discountPct);p.paymentDays=Number(p.paymentDays);await api("finance/client-pricing",p);}
      else if(kind==="recurring-invoice"){p.lines=singleLine(form);p.paymentDays=Number(p.paymentDays);await api("finance/recurring",p);}
      else if(kind==="credit-note"){p.amount=Number(p.amount);await api("finance/credit-note",p);}
      else if(kind==="payment-link"){const out=await api("finance/payment-link",{invoiceId:p.invoiceId,days:Number(p.days)});navigator.clipboard?.writeText(location.origin+out.url).catch(()=>{});core().notice("Lien créé et copié : "+location.origin+out.url);}
      else if(kind==="location") await api("procurement/location",p);
      else if(kind==="order"){p.lines=singleLine(form);await api("procurement/order",p);}
      else if(kind==="barcode") await api("procurement/barcode",p);
      else if(kind==="tool-event") await api("assets/tool-event",p);
      else if(kind==="vehicle-event"){if(p.km)p.km=Number(p.km);await api("assets/vehicle-event",p);}
      else if(kind==="maintenance-plan"){p.autoInvoice=fd.get("autoInvoice")==="on";p.paymentDays=Number(p.paymentDays||30);if(p.autoInvoice)p.invoiceLines=singleLine(form);await api("maintenance/plan",p);}
      else if(kind==="integration"){p.enabled=fd.get("enabled")==="on";await api("integrations",p);}
      core().closeModal(true); core().toast("P1 · modification enregistrée.");
      const root=document.getElementById("p1Suite")?.parentElement; if(root) await renderInto(root);
    }catch(e){const el=document.getElementById("formError");if(el)el.textContent=e.message;else core().notice(e.message);}
  }

  function currentPosition(){
    return new Promise((resolve)=>{
      if(!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p)=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy}),
        ()=>resolve(null),
        {enableHighAccuracy:true,timeout:7000,maximumAge:60000}
      );
    });
  }
  async function clockAction(action, payload={}){
    const project=action==="clock.start"?payload.project:(state().clocks||[])[0]?.project;
    let policy=null;
    const p=projects().find(x=>String(x.id)===String(project));
    if(p) policy=(await api("time/policy?company="+encodeURIComponent(p.company)).catch(()=>null))?.policy;
    const geo=policy?.geolocation_enabled?await currentPosition():null;
    const result=await core().mutate(action,payload);
    if(!result) return result;
    const projectIdValue=result.project||project;
    if(geo) await api("time/geolocation",{...geo,action:action==="clock.stop"?"stop":"start",projectId:projectIdValue,timeId:action==="clock.stop"?result.id:null}).catch(()=>{});
    if(action==="clock.stop"&&result.id){
      const applied=await api("time/auto-break",{timeId:result.id}).catch(()=>null);
      if(applied?.applied){await core().refresh();core().toast("Pause automatique appliquée : "+applied.minutes+" min.");}
    }
    return result;
  }

  async function scanCode(onCode){
    if(!("BarcodeDetector" in window)){
      const value=prompt("Scanner non disponible sur ce navigateur. Saisissez le code :");
      if(value) await onCode(value.trim());
      return;
    }
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
    const video=document.createElement("video"); video.autoplay=true; video.playsInline=true; video.srcObject=stream;
    modal("Scanner QR / code-barres",`<div id="p1Scanner" class="p1-scanner"></div><p>Placez le code dans l’image.</p>`);
    document.getElementById("p1Scanner")?.appendChild(video);
    const detector=new BarcodeDetector({formats:["qr_code","code_128","ean_13","ean_8","data_matrix"]});
    let done=false;
    const tick=async()=>{
      if(done||!document.body.contains(video)){stream.getTracks().forEach(t=>t.stop());return;}
      try{const codes=await detector.detect(video);if(codes[0]?.rawValue){done=true;stream.getTracks().forEach(t=>t.stop());core().closeModal(true);await onCode(codes[0].rawValue);return;}}catch{}
      requestAnimationFrame(tick);
    }; tick();
  }

  async function dashboardEnhance(){
    if(core()?.getPage?.()!=="dashboard") return;
    const content=document.getElementById("content"); if(!content||content.querySelector(".p1-dashboard-extra")) return;
    try{
      const out=await api("dashboard"), prefs=out.preferences||{};
      const planning=prefs.showPlanning===false?"":`<article class="card"><h3>Prochaines interventions</h3><div class="p1-list">${(out.planning||[]).map(x=>`<div><span><b>${esc(projects().find(p=>String(p.id)===String(x.project))?.title||x.project)}</b><small>${date(x.date)} · ${esc(x.start)}–${esc(x.end)}</small></span></div>`).join("")||"<p>Aucune intervention planifiée.</p>"}</div></article>`;
      content.insertAdjacentHTML("afterbegin",`<section class="p1-dashboard-extra ${prefs.compact?"compact":""}"><div class="p1-dashboard-head"><span>P1 · Tableau personnalisé</span>${btn("Personnaliser","dashboard-settings")}</div><div class="p1-dashboard-grid"><article class="card"><h3>Notifications</h3><b class="p1-big">${esc(out.kpis?.unread||0)}</b><small>non lues</small></article>${planning}</div></section>`);
    }catch{}
  }

  async function afterRender(){
    watchTranslations();
    translateDom();
    await dashboardEnhance();
  }

  document.addEventListener("click",async(e)=>{
    const tab=e.target.closest("[data-p1-area]");
    if(tab){area=tab.dataset.p1Area;const root=document.getElementById("p1Suite")?.parentElement;if(root)await renderInto(root);return;}
    const b=e.target.closest("[data-p1-action]"); if(!b)return;
    const a=b.dataset.p1Action;
    try{
      if(a==="new-milestone")openForm("milestone");
      else if(a==="new-subtask")openForm("subtask",{parent:b.dataset.parent});
      else if(a==="new-checklist")openForm("checklist");
      else if(a==="new-report")openForm("report");
      else if(a==="new-punch")openForm("punch");
      else if(a==="new-change-order")openForm("change-order");
      else if(a==="new-photo-meta")openForm("photo-meta");
      else if(a==="delete-milestone"){if(confirm("Supprimer ce jalon ?")){await api("project/"+encodeURIComponent(projectId)+"/milestone/delete",{id:b.dataset.id});const root=document.getElementById("p1Suite")?.parentElement;if(root)await renderInto(root);}}
      else if(a==="project-history"){const out=await api("project/"+encodeURIComponent(projectId)+"/history");modal("Historique · "+out.project.title,`<div class="p1-timeline">${(out.history||[]).map(x=>`<div><i></i><span><b>${esc(x.title)}</b><small>${date(x.at)} · ${esc(x.type)}</small></span></div>`).join("")}</div>`);}
      else if(a==="quick-clock-start")await clockAction("clock.start",{project:b.dataset.project});
      else if(a==="quick-clock-stop")await clockAction("clock.stop",{});
      else if(a==="scan-project")await scanCode(async(code)=>{const p=projects().find(x=>String(x.id)===String(code)||String(code).includes(String(x.id)));if(!p)throw new Error("Chantier non reconnu.");projectId=p.id;area="project";const root=document.getElementById("p1Suite")?.parentElement;if(root)await renderInto(root);});
      else if(a==="finance-template")openForm("finance-template");
      else if(a==="finance-catalog")openForm("finance-catalog");
      else if(a==="client-pricing")openForm("client-pricing");
      else if(a==="recurring-invoice")openForm("recurring-invoice");
      else if(a==="credit-note")openForm("credit-note");
      else if(a==="payment-link")openForm("payment-link");
      else if(a==="run-reminders"){const out=await api("finance/run-reminders",{});core().toast(out.created+" relance(s) générée(s).");}
      else if(a==="new-location")openForm("location");
      else if(a==="new-order")openForm("order");
      else if(a==="new-barcode")openForm("barcode");
      else if(a==="scan-item")await scanCode(async(code)=>{const out=await api("procurement/lookup/"+encodeURIComponent(code));modal("Article scanné",`<p><b>${esc(out.item.name)}</b></p><p>Stock : ${esc(out.item.stock)} ${esc(out.item.unit||"")}</p>`);});
      else if(a==="tool-event")openForm("tool-event");
      else if(a==="vehicle-event")openForm("vehicle-event");
      else if(a==="maintenance-plan")openForm("maintenance-plan");
      else if(a==="integration")openForm("integration",{provider:b.dataset.provider});
      else if(a==="run-jobs"){const out=await api("run-jobs",{});core().toast(`Jobs terminés : ${out.invoices} facture(s), ${out.maintenance} maintenance(s), ${out.reminders} relance(s).`);}
      else if(a==="dashboard-settings"){
        const out=await api("dashboard"),p=out.preferences||{};
        modal("Personnaliser le tableau de bord",`<form id="p1Form" data-kind="dashboard-settings"><label class="p1-check"><input type="checkbox" name="compact" ${p.compact?"checked":""}> Mode compact</label><label class="p1-check"><input type="checkbox" name="showPlanning" ${p.showPlanning!==false?"checked":""}> Afficher les prochaines interventions</label><label class="p1-check"><input type="checkbox" name="showAlerts" ${p.showAlerts!==false?"checked":""}> Afficher les alertes</label><button class="btn primary" type="submit">Enregistrer</button></form>`);
      }
    }catch(err){core().notice(err.message);}
  });
  document.addEventListener("change",async(e)=>{
    if(e.target.id==="p1ProjectSelect"){projectId=e.target.value;const root=document.getElementById("p1Suite")?.parentElement;if(root)await renderInto(root);}
    else if(e.target.id==="p1TimeCompany"){cache.timeCompany=e.target.value;const root=document.getElementById("p1Suite")?.parentElement;if(root)await renderInto(root);}
    else if(e.target.matches("[data-p1-checklist]")){await opsApi("project/"+encodeURIComponent(projectId)+"/checklist",{id:e.target.dataset.p1Checklist,label:e.target.closest("label")?.innerText?.trim()||"Contrôle",completed:e.target.checked});const root=document.getElementById("p1Suite")?.parentElement;if(root)await renderInto(root);}
  });
  document.addEventListener("submit",async(e)=>{
    if(e.target.id!=="p1Form")return;e.preventDefault();
    if(e.target.dataset.kind==="dashboard-settings"){
      const fd=new FormData(e.target);
      await api("dashboard/preferences",{compact:fd.get("compact")==="on",showPlanning:fd.get("showPlanning")==="on",showAlerts:fd.get("showAlerts")==="on"});
      core().closeModal(true);await core().render();return;
    }
    await submit(e.target);
  });

  window.SGOP1Suite={render:renderInto,afterRender,clockAction,translateDom};
})();