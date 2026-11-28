"use strict";
const $ = (id) => document.getElementById(id);
const companyLogoPath = (id, issuer) =>
  `/assets/logos/${SousaFinance.companyBrand(id, issuer || state?.companies.find((c) => c.id === id))}.png`;
let financeClientDraft = null;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n) =>
  new Intl.NumberFormat("fr-CH", {
    style: "currency",
    currency: "CHF",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n) || 0);
const date = (v) => {
  if (!v) return "—";
  const value = new Date(v.length === 10 ? v + "T12:00:00" : v);
  return window.SGOAccountPreferences?.dateFormat === "ISO"
    ? value.toISOString().slice(0, 10)
    : value.toLocaleDateString("fr-CH");
};
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const same = (a, b) => a != null && b != null && String(a) === String(b);
let token = sessionStorage.getItem("sgo_session") ? "cookie" : null,
  state = null,
  profile = null,
  contacts = [],
  messageStats = {},
  chatHistoryCache = new Map(),
  revision = 0,
  page = "dashboard",
  company = "",
  selectedRecipient = "",
  selectedThreadId = "",
  chatReplyToId = "",
  chatAttachmentDraft = null,
  chatRecorder = null,
  chatSending = false,
  chatMediaGeneration = 0,
  chatRecordingDiscard = false,
  activeCall = null,
  incomingCall = null,
  callStatusTimer = null,
  callCandidateCursor = 0,
  pendingIceCandidates = [],
  remoteIceQueue = [],
  callPollBusy = false,
  callAudioBlocked = false,
  callEndUiTimer = null,
  rtcIceServers = null,
  ringtoneTimer = null,
  ringAudioContext = null,
  mobileChatOpen = false,
  userAccounts = [],
  pending = false,
  lastFocus;
// Remove data cached by the previous version, including the old long-lived token.
localStorage.removeItem("sgo_token");
localStorage.removeItem("sgo_complete_v4");
const roles = {
  admin: "Administration",
  direction: "Direction",
  hr: "RH",
  manager: "Responsable",
  accounting: "Comptabilité",
  employee: "Salarié",
  client: "Client",
};
const core = ["admin", "direction"],
  hr = [...core, "hr"],
  ops = [...core, "manager"],
  fin = [...core, "accounting"];
const menus = {
  dashboard: ["Tableau de bord", Object.keys(roles)],
  companies: ["Entreprises", core],
  employees: ["Salariés et comptes", [...hr, "manager"]],
  time: ["Heures", [...hr, "manager", "accounting", "employee"]],
  planning: ["Planning", [...hr, "manager", "employee"]],
  absences: ["Absences", [...hr, "manager", "employee"]],
  projects: ["Chantiers", [...ops, "accounting", "employee", "client"]],
  clients: ["Clients", [...ops, "accounting"]],
  quotes: ["Devis", [...fin, "client"]],
  invoices: ["Factures", [...fin, "client"]],
  payments: ["Paiements", fin],
  expenses: ["Dépenses", [...ops, "accounting"]],
  inventory: ["Matériel", [...ops, "accounting", "employee"]],
  suppliers: ["Fournisseurs", [...ops, "accounting"]],
  vehicles: ["Véhicules", [...ops, "accounting"]],
  tools: ["Outillage", [...ops, "accounting", "employee"]],
  maintenance: ["Maintenance", [...ops, "accounting", "client"]],
  trade: ["Démarches", [...ops, "accounting"]],
  documents: ["Documents", Object.keys(roles)],
  messages: ["Messages", Object.keys(roles)],
  mailbox: ["Boîte mail", Object.keys(roles).filter((r) => r !== "client")],
  whatsapp: ["WhatsApp", Object.keys(roles).filter((r) => r !== "client")],
  phone: ["Téléphone", Object.keys(roles).filter((r) => r !== "client")],
  reports: ["Rapports", [...core, "hr", "accounting", "manager"]],
  pilotage: ["Pilotage", [...core, "hr", "manager", "accounting", "employee"]],
  pro: ["Centre de gestion", [...core, "hr", "manager", "accounting", "employee"]],
  advanced: ["Outils avancés", Object.keys(roles)],
  users: ["Comptes", ["admin"]],
  audit: ["Journal", hr],
  settings: ["Mon compte", Object.keys(roles)],
};
// Presentation-only navigation: seven sections instead of a long list; the pages of a section
// are its tabs. Existing role and fine-permission checks remain authoritative.
const navSections = [
  { id: "home", label: "Accueil", icon: "dashboard", pages: ["dashboard"] },
  { id: "communication", label: "Communication", icon: "messages", pages: ["messages", "mailbox", "whatsapp", "phone"] },
  { id: "work", label: "Chantiers", icon: "projects", pages: ["projects", "clients", "maintenance", "trade", "documents"] },
  { id: "team", label: "Équipe", icon: "planning", pages: ["planning", "time", "absences", "employees"] },
  { id: "money", label: "Finances", icon: "invoices", pages: ["quotes", "invoices", "payments", "expenses"] },
  { id: "stock", label: "Matériel", icon: "inventory", pages: ["inventory", "tools", "vehicles", "suppliers"] },
  { id: "manage", label: "Gestion", icon: "pro", pages: ["pro", "pilotage", "reports", "companies", "advanced", "audit", "settings"] },
];
const navigationGroups = navSections.map((s) => [s.label, s.pages]);
// What the person calls things: a client's « Gestion » is their own space.
function sectionLabel(s) {
  if (s.id === "manage") return profile?.role === "client" ? "Mon espace" : profile?.role === "employee" ? "Outils" : s.label;
  return s.label;
}
function pageLabel(k) {
  if (k === "advanced" && profile?.role === "client") return "Mon espace client";
  if (k === "dashboard") return "Accueil";
  return menus[k]?.[0] || k;
}
// The trade of a company (électricité, solaire, déménagement), from its sector or name.
function tradeKind(c) {
  const t = [c?.type, c?.name, c?.id].join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /electric/.test(t) ? "electricite" : /solai|solar/.test(t) ? "solaire" : /demenag|moving/.test(t) ? "demenagement" : "";
}
const hasTrade = (...kinds) => (state?.companies || []).some((c) => c.id !== "group" && kinds.includes(tradeKind(c)) && (profile?.company === "group" || profile?.company === c.id || (profile?.companies || []).includes(c.id)));
window.SGOTradeKind = tradeKind;
function pageAvailable(k) {
  return (
    !!menus[k] &&
    (k !== "trade" || hasTrade("electricite", "solaire")) &&
    can(menus[k][1]) &&
    k !== "users" &&
    (k !== "mailbox" || !!window.SGOWebmail?.hasAccess?.()) &&
    (k !== "whatsapp" || !!window.SGOWhatsApp?.hasAccess?.()) &&
    (k !== "phone" || !!window.SGOPhone?.hasAccess?.())
  );
}
function availableSections() {
  return navSections.map((s) => ({ ...s, pages: s.pages.filter(pageAvailable) })).filter((s) => s.pages.length);
}
function pageUnread(k) {
  if (k === "messages") return Object.values(messageStats || {}).reduce((total, stat) => total + Number(stat?.unread || 0), 0);
  if (k === "mailbox") return Number(window.SGOWebmail?.unreadTotal?.() || 0);
  if (k === "whatsapp") return Number(window.SGOWhatsApp?.unreadTotal?.() || 0);
  if (k === "phone") return Number(window.SGOPhone?.unreadTotal?.() || 0);
  return 0;
}
const unreadBadge = (n) => (n ? `<span class="nav-unread">${n > 99 ? "99+" : n}</span>` : "");
// The page last opened in each section, to come back to it.
const lastPageIn = {};
// Unread counters of the menu, the tabs and the phone bar, without drawing the page again.
function updateBadges() {
  for (const el of document.querySelectorAll("[data-section]")) {
    const s = availableSections().find((x) => x.id === el.dataset.section);
    const n = s ? s.pages.reduce((t, k) => t + pageUnread(k), 0) : 0;
    el.querySelector(".nav-unread")?.remove();
    if (n) el.insertAdjacentHTML("beforeend", unreadBadge(n));
  }
  for (const el of document.querySelectorAll(".section-tab[data-page]")) {
    const n = pageUnread(el.dataset.page);
    el.querySelector(".nav-unread")?.remove();
    if (n) el.insertAdjacentHTML("beforeend", unreadBadge(n));
  }
}
// Phone bar: four sections chosen for the role, then « Plus » for the others.
const BOTTOM_SECTIONS = {
  client: ["home", "work", "money", "communication"],
  employee: ["home", "team", "work", "communication"],
  accounting: ["home", "money", "work", "communication"],
  hr: ["home", "team", "communication", "work"],
  default: ["home", "communication", "work", "money"],
};
function navigationIcon(key) {
  const paths = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    go: '<path d="m3 11 18-8-8 18-2-8-8-2Z"/>',
    trade: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 12l2 2 4-4"/>',
    messages: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M8 9h8M8 13h5"/>',
    mailbox: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    whatsapp: '<path d="M4 20.5l1.2-3.9A8.5 8.5 0 1 1 8.3 19.6L4 20.5Z"/><path d="M9.2 8.6c.3 2.6 2.4 4.8 5.1 5.4l1-1.2-1.7-1-.8.7a4.6 4.6 0 0 1-2.1-2.1l.7-.8-1-1.7-1.2.7Z"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
    employees: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2"/>',
    planning: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h3M14 15h3"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    absences: '<path d="M4 17a8 8 0 0 1 16 0H4ZM12 17v4M12 3v3M4 6l2 2M20 6l-2 2"/>',
    projects: '<path d="M3 21V6h11v15M14 11h7v10M7 10h3M7 14h3M7 18h3M17 15h1M17 18h1"/>',
    clients: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    documents: '<path d="M4 6h6l2 3h8v11H4V6Z"/>',
    quotes: '<path d="M6 3h9l4 4v14H6V3ZM14 3v5h5M9 12h7M9 16h5"/>',
    invoices: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6"/>',
    payments: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
    expenses: '<path d="M4 8h16v12H4V8ZM7 8V4h10v4M9 14h6"/>',
    inventory: '<path d="m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10"/>',
    vehicles: '<path d="M3 7h11v11H3V7Zm11 4h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
    reports: '<path d="M4 3v18h17M8 16v-4M13 16V7M18 16v-7"/>',
    settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    pro: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/>',
  };
  const aliases = {maintenance:"planning",tools:"settings",suppliers:"inventory",companies:"projects",pilotage:"reports",advanced:"dashboard",audit:"quotes"};
  return `<svg class="nav-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[key] || paths[aliases[key]] || paths.documents}</svg>`;
}
// Shared line icons, same drawing style as the navigation. Used instead of emoji in the interface chrome.
const UI_ICONS = {
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  "list-ordered": '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5h1.5V9M4 9h3M4 14.5a1.5 1.5 0 0 1 3 0c0 1.5-3 2-3 4h3"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  eraser: '<path d="m7 21-4-4 11-11 7 7-8 8H7Z"/><path d="M21 21H11M8.5 10.5l7 7"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>',
  reply: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
  "reply-all": '<path d="M11 7l-5 5 5 5"/><path d="M7 7l-5 5 5 5"/><path d="M6 12h9a6 6 0 0 1 6 6v1"/>',
  forward: '<path d="m15 7 5 5-5 5"/><path d="M20 12H10a6 6 0 0 0-6 6v1"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5L5.5 5Z"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  "mail-open": '<path d="M3 10 12 4l9 6v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9Z"/><path d="m3 10 9 6 9-6"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4l2-2Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  "bell-off": '<path d="M6 16v-5a6 6 0 0 1 9.5-4.9M18 11v5l2 2H4l2-2"/><path d="M10 20a2 2 0 0 0 4 0M3 3l18 18"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
  hangup: '<path d="M3 14.5v-2C7.5 8.5 16.5 8.5 21 12.5v2a1.5 1.5 0 0 1-1.8 1.5l-3-.6a1.5 1.5 0 0 1-1.2-1.5V12a10 10 0 0 0-6 0v1.9a1.5 1.5 0 0 1-1.2 1.5l-3 .6A1.5 1.5 0 0 1 3 14.5Z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  "video-off": '<path d="M9 6h5a2 2 0 0 1 2 2v3l5-3v9M16 16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2M3 3l18 18"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  "mic-off": '<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4V9Z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4V8Z"/><circle cx="12" cy="13" r="3.5"/>',
  file: '<path d="M6 3h9l4 4v14H6V3ZM14 3v5h5M9 12h7M9 16h5"/>',
  paperclip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
  send: '<path d="M4 12 20 4l-5 16-3-7-8-1Z"/><path d="m12 13 8-9"/>',
  "arrow-left": '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2"/>',
  building: '<path d="M3 21V6h11v15M14 11h7v10M7 10h3M7 14h3M7 18h3M17 15h1M17 18h1"/>',
  message: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M8 9h8M8 13h5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 12h18"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/>',
  settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  folder: '<path d="M4 6h6l2 3h8v11H4V6Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v8"/>',
  go: '<path d="m3 11 18-8-8 18-2-8-8-2Z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  sparkle: '<path d="M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7L11 3.5Z"/><path d="M18.5 14.5l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1Z"/>',
};
function uiIcon(name, cls = "") {
  return `<svg class="ui-icon${cls ? " " + cls : ""}" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${UI_ICONS[name] || UI_ICONS.more}</svg>`;
}
window.SGOIcon = uiIcon;
const createRoles = {
  companies: core,
  employees: hr,
  clients: [...ops, "accounting"],
  projects: ops,
  planning: ops,
  quotes: fin,
  invoices: fin,
  payments: fin,
  expenses: [...ops, "accounting"],
  inventory: ops,
  suppliers: ops,
  vehicles: ops,
  tools: ops,
  maintenance: ops,
};
const can = (rs) => {
  if (!profile) return false;
  const base = rs.includes(profile.role);
  if (profile.role === "admin") return base;
  const denials = Array.isArray(profile.permission_denials) ? profile.permission_denials : [];
  if (base && denials.includes(profile.role)) return false;
  const grants = Array.isArray(profile.permission_grants) ? profile.permission_grants : [];
  return base || grants.some((role) => rs.includes(role) && !denials.includes(role));
};
const visible = (k) =>
  (state?.[k] || []).filter((x) => {
    if (x.deletedAt && k !== "messages") return false;
    if (!company) return true;
    const employee =
      k === "employees"
        ? x
        : state.employees.find((e) => same(e.id, x.employeeId));
    if (k === "employees" || k === "absences")
      return (
        !employee ||
        [employee.company, ...(employee.companies || [])].includes(company)
      );
    const scope =
      x.company ||
      (x.project &&
        state.projects.find((p) => same(p.id, x.project))?.company) ||
      employee?.company;
    return !scope || scope === company;
  });
const find = (k, id) => state[k]?.find((x) => same(x.id, id));
const name = (k, id) => {
  const r = find(k, id);
  return r?.name || r?.title || id || "—";
};
const btn = (label, action, id = "", kind = "secondary") =>
  `<button type="button" class="btn ${kind}" data-action="${esc(action)}" data-id="${esc(id)}">${esc(label)}</button>`;
// « Y aller »: an address opens in the navigation app chosen on this device (asked the first time).
const NAV_APPS = { google: "Google Maps", waze: "Waze", apple: "Plans (Apple)" };
function navApp() {
  try {
    const v = localStorage.getItem("sgo-nav-app");
    return NAV_APPS[v] ? v : "";
  } catch {
    return "";
  }
}
function navUrl(address, app = navApp() || "google") {
  const q = encodeURIComponent(String(address).trim());
  return app === "waze"
    ? `https://waze.com/ul?q=${q}&navigate=yes`
    : app === "apple"
      ? `https://maps.apple.com/?daddr=${q}`
      : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
// Several stops in a row (Google Maps: Waze and Plans take one destination at a time).
function tourUrl(addresses) {
  const stops = [...new Set(addresses.map((a) => String(a || "").trim()).filter(Boolean))].slice(0, 10);
  const destination = stops.pop();
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}${stops.length ? "&waypoints=" + encodeURIComponent(stops.join("|")) : ""}&travelmode=driving`;
}
const clientAddress = (c) => (c ? [[c.street, c.buildingNumber].filter(Boolean).join(" "), [c.zip, c.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "");
const planningAddress = (p) => find("projects", p.project)?.address || p.location || "";
const goButton = (address, label = "Y aller") =>
  String(address || "").trim()
    ? `<button type="button" class="btn secondary go-btn" data-action="go-to" data-id="${esc(String(address).trim())}" title="Itinéraire vers ${esc(address)}">${uiIcon("go")}<span>${esc(label)}</span></button>`
    : "";
function todayStops(employeeId) {
  return visible("planning")
    .filter((x) => x.date === today() && same(x.employeeId, employeeId))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(planningAddress)
    .filter(Boolean);
}
function openNavigation(url) {
  const w = window.open(url, "_blank", "noopener");
  if (!w) location.href = url;
}
function chooseNavApp(address) {
  modal(
    "Ouvrir l’itinéraire avec…",
    `<p class="muted">${esc(address)}</p><div class="go-apps">${Object.entries(NAV_APPS)
      .map(([id, label]) => `<button type="button" class="btn ${id === "google" ? "primary" : "secondary"}" data-action="go-app" data-id="${id}">${esc(label)}</button>`)
      .join("")}</div><label class="go-remember"><input type="checkbox" id="goRemember" checked> Toujours utiliser cette application sur cet appareil</label><p class="muted">Vous pourrez changer d’application depuis le planning (« Changer d’application »).</p>`,
  );
  goPending = address;
}
let goPending = "";
// Statuses in colour: done in green, under way in blue, waiting in orange, a problem in red.
const STATUS_TONE = {
  ok: ["Payée", "Payé", "Accepté", "Acceptée", "Validée", "Validé", "Approuvée", "Approuvé", "Terminé", "Terminée", "Actif", "Active", "Signé", "Signée", "En service", "Livré", "Livrée", "Encaissé"],
  info: ["Émise", "Émis", "Envoyé", "Envoyée", "En cours", "Planifié", "Planifiée", "Ouvert", "Ouverte", "Confirmé", "Confirmée"],
  warning: ["En attente", "Partiellement payée", "Partiel", "À valider", "Proposé", "Proposée", "En pause", "À relancer"],
  danger: ["En retard", "Refusé", "Refusée", "Annulé", "Annulée", "Rejeté", "Rejetée", "Hors service", "Expiré", "Expirée", "Bloqué", "Bloquée", "Échec"],
};
const statusTone = (s) => Object.keys(STATUS_TONE).find((k) => STATUS_TONE[k].includes(String(s ?? "").trim())) || "neutral";
const badge = (s) => `<span class="status ${statusTone(s)}">${esc(s)}</span>`;
const kpi = (label, value) =>
  `<article class="card kpi"><p class="muted">${esc(label)}</p><b class="kpi-value">${esc(value)}</b></article>`;
const cards = (items) =>
  `<div class="grid g3 section">${items.map((x) => kpi(...x)).join("")}</div>`;
// Classifies a table cell so amounts, dates and references never break mid-word,
// and action buttons can be grouped (see enhanceContent).
function cellKind(html) {
  const s = String(html ?? "");
  if (/class="btn /.test(s)) return "cell-actions";
  const text = s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
  if (
    /^-?[\d\s  '’.,]+\s?(CHF|%|h|j)$/i.test(text) ||
    /^CHF\s?-?\d/.test(text) ||
    /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(text) ||
    /^\d{4}-\d{2}-\d{2}$/.test(text) ||
    /^[A-Z]{1,4}-\d{4}-\d+$/.test(text)
  )
    return "cell-nowrap";
  return "";
}
function table(headers, rows) {
  return rows.length
    ? `<article class="card"><div class="table"><table class="data-table"><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows
        .map(
          (r) =>
            `<tr>${r
              .map((x, i) => {
                const kind = cellKind(x),
                  label = headers[i] || "";
                return `<td${kind ? ` class="${kind}"` : ""}${label ? ` data-label="${esc(label)}"` : ""}>${x ?? ""}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")}</tbody></table></div></article>`
    : `<article class="card empty">${navigationIcon("documents")}<strong>Aucun élément pour le moment.</strong><span>Les éléments disponibles dans cet espace apparaîtront ici.</span></article>`;
}
const compactLayout = window.matchMedia?.("(max-width: 760px)") || { matches: false, addEventListener() {} };
// Post-render layout helpers: one primary action per table row with the others
// (including deletion) in a "⋯" menu, and on phones a "Plus" menu for page header actions.
function enhanceContent(root) {
  if (!root) return;
  for (const cell of root.querySelectorAll("table.data-table td.cell-actions:not([data-enhanced])")) {
    cell.dataset.enhanced = "1";
    const buttons = [...cell.querySelectorAll(":scope > button.btn")];
    const primary = buttons.find((b) => !b.classList.contains("danger"));
    const rest = buttons.filter((b) => b !== primary);
    if (!rest.length) continue;
    const menu = document.createElement("details");
    menu.className = "row-more";
    menu.innerHTML = `<summary title="Plus d’actions" aria-label="Plus d’actions">${uiIcon("more")}</summary><div class="row-more-menu"></div>`;
    const list = menu.querySelector(".row-more-menu");
    for (const b of rest) list.append(b);
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      // Float the menu next to its button so it never stretches the row or gets clipped by the table scroll area.
      const r = menu.querySelector("summary").getBoundingClientRect();
      list.style.left = "0px";
      list.style.top = "0px";
      const w = list.offsetWidth,
        h = list.offsetHeight;
      list.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
      list.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6) + "px";
    });
    if (primary) primary.after(menu);
    else cell.prepend(menu);
  }
  if (!compactLayout.matches) return;
  for (const box of root.querySelectorAll(".section-head > .actions:not([data-enhanced])")) {
    box.dataset.enhanced = "1";
    const buttons = [...box.querySelectorAll(":scope > button")];
    if (buttons.length < 3) continue;
    const primary = buttons.find((b) => b.classList.contains("primary")) || buttons[0];
    // Buttons marked data-keep-visible (e.g. "Lire une facture" on phones) stay next to the primary one.
    const movable = buttons.filter((b) => b !== primary && !b.hasAttribute("data-keep-visible"));
    if (!movable.length) continue;
    const menu = document.createElement("details");
    menu.className = "head-more";
    menu.innerHTML = `<summary class="btn secondary">Plus ${uiIcon("chevron-down")}</summary><div class="head-more-menu"></div>`;
    const list = menu.querySelector(".head-more-menu");
    for (const b of movable) list.append(b);
    box.append(menu);
  }
}
{
  let queued = false;
  const run = () => {
    queued = false;
    enhanceContent($("content"));
    enhanceContent($("modalBody"));
  };
  const observer = window.MutationObserver && new MutationObserver(() => {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(run);
  });
  for (const id of ["content", "modalBody"]) {
    const el = $(id);
    if (el && observer) observer.observe(el, { childList: true, subtree: true });
  }
  // Close any open "⋯" / "Plus" menu when clicking elsewhere or choosing an action in it.
  document.addEventListener("click", (e) => {
    for (const menu of document.querySelectorAll("details.row-more[open], details.head-more[open], details.chat-new-menu[open]"))
      if (!menu.contains(e.target) || e.target.closest("button")) menu.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const menu of document.querySelectorAll("details.row-more[open], details.head-more[open], details.chat-new-menu[open]")) menu.open = false;
  });
  // A floating row menu would drift away from its button while scrolling: close it.
  window.addEventListener(
    "scroll",
    () => {
      for (const menu of document.querySelectorAll("details.row-more[open]")) menu.open = false;
    },
    true,
  );
  window.addEventListener("resize", () => {
    for (const menu of document.querySelectorAll("details.row-more[open]")) menu.open = false;
  });
  compactLayout.addEventListener("change", () => {
    if (state && profile) render();
  });
}
function heading(title, actions = "") {
  // The page's name is already the title above: it is kept only for screen readers.
  const same = typeof page !== "undefined" && (title === menus[page]?.[0] || title === pageLabel(page));
  return `<div class="section-head${same ? " no-title" : ""}"><h3${same ? ' class="sr-only"' : ""}>${esc(title)}</h3><div class="actions">${actions}</div></div>`;
}
function toast(t) {
  $("toast").textContent = t;
  $("toast").classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.add("hidden"), 4500);
}
function notice(t) {
  $("notice").textContent = t;
  $("notice").classList.toggle("hidden", !t);
}
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== "auth/login") clearSession();
    const e = new Error(data.error || "Réponse serveur invalide.");
    e.status = r.status;
    e.code = data.code || "";
    throw e;
  }
  return data;
}
const chatTextDrafts = new Map();
const chatMessageLimits = new Map();
const chatKey = () =>
  selectedThreadId
    ? "thread:" + selectedThreadId
    : "direct:" + selectedRecipient;
function rememberChatText() {
  const form = $("messageForm"),
    composer = $("messageText");
  if (form && composer)
    chatTextDrafts.set(form.dataset.conversation, composer.value);
}
function selectChat(key) {
  if (key !== chatKey()) {
    cancelChatRecording();
    chatReplyToId = "";
    chatAttachmentDraft = null;
  }
  if (key.startsWith("thread:")) {
    selectedThreadId = key.slice(7);
    selectedRecipient = "";
  } else {
    selectedRecipient = key.replace(/^direct:/, "");
    selectedThreadId = "";
  }
}
function markVoiceButtons(recording) {
  for (const button of document.querySelectorAll('[data-action="chat-voice"]')) {
    button.classList.toggle("recording", recording);
    button.innerHTML = uiIcon(recording ? "stop" : "mic");
    button.setAttribute("aria-label", recording ? "Arrêter l’enregistrement" : "Enregistrer un message vocal");
    button.title = recording ? "Arrêter l’enregistrement" : "Message vocal";
  }
}
function cancelChatRecording() {
  chatMediaGeneration++;
  if (!chatRecorder) return;
  chatRecordingDiscard = true;
  try {
    if (chatRecorder.state !== "inactive") chatRecorder.stop();
  } catch {}
  try {
    chatRecorder.stream?.getTracks().forEach((track) => track.stop());
  } catch {}
}
function clearSession() {
  chatTextDrafts.clear();
  cancelChatRecording();
  if (activeCall || incomingCall) endCurrentCall(false).catch(() => {});
  document.body.dataset.brand = "group";
  token = null;
  state = null;
  profile = null;
  contacts = [];
  messageStats = {};
  chatHistoryCache.clear();
  userAccounts = [];
  selectedRecipient = "";
  selectedThreadId = "";
  chatReplyToId = "";
  chatAttachmentDraft = null;
  chatRecorder = null;
  mobileChatOpen = false;
  company = "";
  page = "dashboard";
  revision = 0;
  sessionStorage.removeItem("sgo_session");
  $("content").replaceChildren();
  $("modalBody").replaceChildren();
  $("printArea").replaceChildren();
  $("modalWrap").classList.add("hidden");
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}
async function refresh(renderNow = true) {
  try {
    const out = await api("state");
    state = out.data;
    messageStats = out.messageStats || {};
    if (chatHistoryCache.size && state?.messages) {
      const known = new Set(state.messages.map((message) => String(message.id)));
      for (const cached of chatHistoryCache.values())
        for (const message of cached || [])
          if (!known.has(String(message.id))) {
            state.messages.push(message);
            known.add(String(message.id));
          }
    }
    revision = out.revision;
    profile = out.profile;
    contacts = out.contacts;
    sessionStorage.setItem(
      "sgo_offline_snapshot",
      JSON.stringify({
        data: state,
        revision,
        profile,
        contacts,
        messageStats,
        savedAt: new Date().toISOString(),
      }),
    );
    document.body.classList.remove("offline-mode");
  } catch (error) {
    if (!navigator.onLine && token) {
      const cached = JSON.parse(
        sessionStorage.getItem("sgo_offline_snapshot") || "null",
      );
      if (cached?.data && cached?.profile) {
        state = cached.data;
        revision = cached.revision || 0;
        profile = cached.profile;
        contacts = cached.contacts || [];
        messageStats = cached.messageStats || {};
        document.body.classList.add("offline-mode");
        notice(
          "Mode hors ligne : dernière copie locale affichée. Les modifications sont désactivées jusqu’au retour du réseau.",
        );
      } else throw error;
    } else throw error;
  }
  if (renderNow) render();
}
// Pages that load their own data and hold user input or results: Pilotage (with the AI assistant),
// advanced tools, management centre, account and supplier catalogue. An automatic refresh updates
// the data but must not rebuild them, which scrolls back to the top and wipes answers and drafts.
const SELF_MANAGED_PAGES = new Set(["pilotage", "advanced", "pro", "settings", "suppliers", "mailbox", "whatsapp", "phone"]);
function userIsTypingInContent() {
  const active = document.activeElement;
  return !!(
    active &&
    $("content")?.contains(active) &&
    active.matches("input, textarea, select, [contenteditable='true']")
  );
}
// Used by the 30-second timer and real-time events. The messages page keeps its own draft
// and scroll handling, so it is rebuilt as before.
async function backgroundRefresh() {
  const keepPage =
    SELF_MANAGED_PAGES.has(page) || (page !== "messages" && userIsTypingInContent());
  await refresh(!keepPage);
}
async function mutate(
  action,
  payload = {},
  collection,
  endpoint = "state/command",
  form,
) {
  const requestId = form?.dataset.requestId || crypto.randomUUID();
  if (!navigator.onLine) {
    const queued = await window.SGOP2Runtime?.queueMutation?.({
      action,
      payload,
      collection,
      endpoint,
      requestId,
    });
    if (queued) {
      if (form) delete form.dataset.requestId;
      closeModal(true);
      notice("Mode hors ligne : modification enregistrée sur cet appareil et envoyée automatiquement au retour du réseau.");
      toast("Modification mise en attente de synchronisation.");
      return { queued: true, requestId };
    }
    notice("Connexion requise pour cette modification.");
    return;
  }
  if (pending) return;
  pending = true;
  const buttons = [...document.querySelectorAll("button[type=submit]")];
  buttons.forEach((b) => (b.disabled = true));
  let saved = false,
    savedResult;
  if (form) form.dataset.requestId = requestId;
  try {
    const out = await api(endpoint, {
      action,
      payload,
      collection,
      revision,
      requestId,
    });
    saved = true;
    savedResult = out.result;
    if (form) delete form.dataset.requestId;
    await refresh();
    closeModal(true);
    notice("");
    toast("Modification enregistrée.");
    return out.result;
  } catch (e) {
    if (e.status === 409) {
      if (form) delete form.dataset.requestId;
      await refresh(false).catch(() => {});
      e.message += " Votre formulaire est conservé.";
    }
    if (saved) {
      closeModal(true);
      notice(
        "Modification enregistrée, mais actualisation impossible. Cliquez sur Actualiser.",
      );
      return savedResult;
    } else {
      const target = $("formError");
      if (target) target.textContent = e.message;
      else notice(e.message);
    }
  } finally {
    pending = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}
// A state command for features that show their own result (the AI assistant's confirmed
// actions): errors are thrown to the caller instead of being shown in a form.
async function command(action, payload = {}, collection) {
  const send = () =>
    api("state/command", { action, payload, collection, revision, requestId: crypto.randomUUID() });
  let out;
  try {
    out = await send();
  } catch (e) {
    // Someone else changed the data meanwhile: reload it and try once more.
    if (e.status !== 409) throw e;
    await refresh(false);
    out = await send();
  }
  await refresh().catch(() => {});
  return out.result;
}
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const b = e.target.querySelector("button");
  b.disabled = true;
  $("loginError").textContent = "";
  try {
    const out = await api("auth/login", {
      email: $("email").value,
      password: $("password").value,
      totpCode: $("totpCode")?.value || "",
    });
    token = "cookie";
    sessionStorage.setItem("sgo_session", "1");
    await refresh(false);
    $("password").value = "";
    if ($("totpCode")) $("totpCode").value = "";
    $("totpWrap")?.classList.add("hidden");
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    render();
  } catch (err) {
    $("loginError").textContent = err.message;
    if (err.code === "TOTP_REQUIRED") {
      $("totpWrap")?.classList.remove("hidden");
      $("totpCode").required = true;
      $("totpCode").focus();
    } else clearSession();
  } finally {
    b.disabled = false;
  }
};
$("companyFilter").onchange = (e) => {
  company = e.target.value;
  render();
};
function render() {
  if (!state || !profile) return;
  rememberChatText();
  const previousKey = $("messageForm")?.dataset.conversation;
  const oldSearch = $("conversationSearch");
  const searchValue = oldSearch?.value || "";
  const searchFocused = document.activeElement === oldSearch;
  const searchSelection = oldSearch ? [oldSearch.selectionStart, oldSearch.selectionEnd] : null;
  const oldComposer = $("messageText");
  const focused = document.activeElement === oldComposer;
  const selection = oldComposer
    ? [oldComposer.selectionStart, oldComposer.selectionEnd]
    : null;
  const oldThread = $("messageThread");
  const threadFocused = document.activeElement === oldThread;
  const scrollTop = oldThread?.scrollTop || 0;
  const atBottom =
    !oldThread ||
    oldThread.scrollHeight - scrollTop - oldThread.clientHeight < 60;
  if (company && !state.companies.some((c) => c.id === company)) company = "";
  const activeCompanyId = company || profile.company;
  document.body.dataset.brand = SousaFinance.companyBrand(
    activeCompanyId,
    state.companies.find((c) => c.id === activeCompanyId),
  );
  if (!can(menus[page]?.[1] || [])) page = "dashboard";
  $("title").textContent = pageLabel(page);
  document.body.dataset.view = page;
  const sections = availableSections();
  const current = sections.find((s) => s.pages.includes(page));
  if (current) lastPageIn[current.id] = page;
  if ($("sectionLabel")) $("sectionLabel").textContent = current ? sectionLabel(current) : "Espace de travail";
  if ($("userInitials"))
    $("userInitials").textContent = profile.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((n) => n[0])
      .join("");
  $("userName").textContent = profile.name + " · " + roles[profile.role];
  const navScroll = $("nav").scrollTop;
  $("nav").innerHTML = `<div class="nav-section">${sections
    .map((sec) => {
      const n = sec.pages.reduce((t, k) => t + pageUnread(k), 0);
      const active = current?.id === sec.id;
      return `<button type="button" class="nav-item nav-sec ${active ? "active" : ""}" data-section="${sec.id}" data-pages="${sec.pages.join(" ")}" ${active ? 'aria-current="page"' : ""}>${navigationIcon(sec.icon)}<span>${esc(sectionLabel(sec))}</span>${unreadBadge(n)}</button>`;
    })
    .join("")}</div>`;
  // The pages of the section, as tabs above the page.
  const tabs = $("sectionTabs");
  if (tabs) {
    const many = current && current.pages.length > 1;
    tabs.classList.toggle("hidden", !many);
    tabs.setAttribute("aria-label", current ? "Pages : " + sectionLabel(current) : "Pages");
    tabs.innerHTML = many
      ? current.pages.map((k) => `<button type="button" class="section-tab ${k === page ? "active" : ""}" data-page="${k}" ${k === page ? 'aria-current="page"' : ""}>${navigationIcon(k)}<span>${esc(pageLabel(k))}</span>${unreadBadge(pageUnread(k))}</button>`).join("")
      : "";
  }
  const bottom = $("bottomNav");
  if (bottom) {
    const wanted = BOTTOM_SECTIONS[profile.role] || BOTTOM_SECTIONS.default;
    const shown = wanted.map((id) => sections.find((x) => x.id === id)).filter(Boolean).slice(0, 4);
    bottom.innerHTML =
      shown
        .map((sec) => {
          const n = sec.pages.reduce((t, k) => t + pageUnread(k), 0);
          const active = current?.id === sec.id;
          // Short words for the phone bar.
          const label = sec.id === "communication" ? "Messages" : sectionLabel(sec);
          return `<button type="button" class="bottom-item ${active ? "active" : ""}" data-section="${sec.id}" ${active ? 'aria-current="page"' : ""} aria-label="${esc(sectionLabel(sec))}">${navigationIcon(sec.icon)}<span>${esc(label)}</span>${unreadBadge(n)}</button>`;
        })
        .join("") +
      `<button type="button" class="bottom-item ${current && !shown.includes(current) ? "active" : ""}" data-action="open-side" aria-label="Toutes les rubriques"><svg class="nav-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg><span>Plus</span></button>`;
  }
  $("nav").scrollTop = navScroll;
  $("companyFilter").innerHTML =
    '<option value="">Vue globale</option>' +
    state.companies
      .filter((c) => c.id !== "group")
      .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
      .join("");
  $("companyFilter").value = company;
  $("activeCompanyLogo").src = companyLogoPath(company || profile.company);
  $("activeCompanyLogo").alt =
    name("companies", company || profile.company) || "Sousa Group";
  $("content").innerHTML = views[page] ? views[page]() : genericPage(page);
  if (page === "suppliers" && window.SGOSuppliers?.render)
    window.SGOSuppliers.render($("supplierCatalog")).catch((e) => notice(e.message));
  if (page === "mailbox") window.SGOWebmail?.render?.($("webmailRoot"));
  if (page === "whatsapp") window.SGOWhatsApp?.render?.($("whatsappRoot"));
  if (page === "phone") window.SGOPhone?.render?.($("phoneRoot"));
  if (page === "trade") window.SGOTrade?.render?.($("tradeRoot"));
  if (page === "advanced" && window.SGOP2Center?.render)
    window.SGOP2Center.render($("p2Standalone")).catch((e) => notice(e.message));
  if (page === "pro" && window.SGOProSuite?.render)
    window.SGOProSuite.render($("proStandalone")).catch((e) => notice(e.message));
  if (
    (page === "users" || page === "employees") &&
    profile.role === "admin" &&
    profile.company === "group"
  )
    loadUsers();
  if (page === "audit") loadAudit();
  if (page === "reports") loadProfitReport();
  if (page === "messages" && $("messageThread")) {
    const sameConversation = previousKey === chatKey();
    $("messageText").value = chatTextDrafts.get(chatKey()) || "";
    $("messageText").readOnly = chatSending;
    if (sameConversation && focused) {
      $("messageText").focus();
      $("messageText").setSelectionRange(...selection);
    }
    $("messageThread").scrollTop =
      sameConversation && !atBottom
        ? scrollTop
        : $("messageThread").scrollHeight;
    if (sameConversation && threadFocused) $("messageThread").focus({ preventScroll: true });
    const search = $("conversationSearch");
    search.value = searchValue;
    filterChatConversations(searchValue);
    if (searchFocused) {
      search.focus();
      search.setSelectionRange(...searchSelection);
    }
    updateChatScrollButton();
    hydrateChatAttachments();
    queueMicrotask(() => markChatRead());
  }
  queueMicrotask(() => {
    window.SGOMessagingSuite?.afterRender?.();
    window.SGOAccountCenter?.afterRender?.();
    window.SGOOperationsCenter?.afterRender?.();
    window.SGOP1Suite?.afterRender?.();
    window.SGOProSuite?.afterRender?.();
    window.SGOP3Center?.afterRender?.();
    window.SGOMailCenter?.afterRender?.();
    window.SGOWebmail?.afterRender?.();
    window.SGOWhatsApp?.afterRender?.();
    window.SGOPhone?.afterRender?.();
    window.SGOTrade?.afterRender?.();
    window.SGOMoving?.afterRender?.();
  });
}
function projectRows(list) {
  return table(
    ["Chantier", "Client", "Statut", "Avancement", "Actions"],
    list.map((p) => [
      esc(p.title) + "<br><small>" + esc(p.id) + "</small>",
      esc(name("clients", p.clientId)),
      badge(p.status),
      esc(p.progress || 0) + " %",
      btn("Ouvrir", "project", p.id),
    ]),
  );
}
function sum(k, field) {
  return visible(k).reduce((n, r) => n + (Number(r[field]) || 0), 0);
}
// Home: what to do first (big buttons), what is waiting (a list that opens the right page),
// and a few numbers that matter. Each role sees its own.
function dashboard() {
  const first = esc(profile.name.split(" ")[0]);
  const todayIso = today();
  const startOfMonth = todayIso.slice(0, 8) + "01";
  const role = profile.role;
  const has = (k) => pageAvailable(k);
  const quick = [];
  const action = (icon, label, attrs) => quick.push({ icon, label, attrs });
  if (role === "client") {
    if (has("projects")) action("projects", "Mes chantiers", 'data-shortcut="projects"');
    if (has("invoices")) action("invoices", "Mes factures", 'data-shortcut="invoices"');
    if (has("quotes")) action("quotes", "Mes devis", 'data-shortcut="quotes"');
    if (has("messages")) action("messages", "Écrire un message", 'data-shortcut="messages"');
  } else {
    if (can(fin)) action("quotes", "Nouveau devis", 'data-action="new" data-id="quotes"');
    if (can(fin)) action("invoices", "Nouvelle facture", 'data-action="new" data-id="invoices"');
    if (can(ops)) action("projects", "Nouveau chantier", 'data-action="new" data-id="projects"');
    if (can(ops)) action("clients", "Nouveau client", 'data-action="new" data-id="clients"');
    if (can(ops)) action("planning", "Planifier", 'data-action="new" data-id="planning"');
    if (role === "employee" && has("planning") && todayStops(profile.employee_id).length)
      action("go", "Y aller", `data-action="go-tour" data-id="${esc(profile.employee_id)}"`);
    if (role === "employee" && has("planning")) action("planning", "Mon planning", 'data-shortcut="planning"');
    if (can([...hr, "manager", "employee"]) && has("time")) action("time", "Ajouter des heures", 'data-action="time-add"');
    if (role === "employee" && has("absences")) action("absences", "Demander une absence", 'data-action="absence-form"');
    if (has("phone")) action("phone", "Appeler", 'data-shortcut="phone"');
    if (has("messages")) action("messages", "Messages", 'data-shortcut="messages"');
  }
  const quickHtml = quick.length
    ? `<section class="home-quick" aria-label="Actions rapides"><h2 class="home-title">Que voulez-vous faire ?</h2><div class="home-quick-grid">${quick
        .slice(0, 8)
        .map((q) => `<button type="button" class="home-action" ${q.attrs}><span class="home-action-icon">${navigationIcon(q.icon)}</span><span>${esc(q.label)}</span></button>`)
        .join("")}</div></section>`
    : "";

  // What is waiting, from the data the person may see.
  const todo = [];
  const open = (inv) => (Number(inv.amount) || 0) - (Number(inv.paid) || 0) > 0.004 && !["Payée", "Annulée", "Brouillon"].includes(inv.status);
  if (has("invoices")) {
    const late = visible("invoices").filter((i) => open(i) && i.due && i.due < todayIso);
    if (late.length)
      todo.push({ tone: "danger", icon: "invoices", page: "invoices", text: role === "client" ? `${late.length} facture${late.length > 1 ? "s" : ""} à régler` : `${late.length} facture${late.length > 1 ? "s" : ""} en retard de paiement`, detail: money(late.reduce((t, i) => t + (Number(i.amount) || 0) - (Number(i.paid) || 0), 0)) });
    const drafts = role === "client" ? [] : visible("invoices").filter((i) => i.status === "Brouillon");
    if (drafts.length) todo.push({ tone: "info", icon: "invoices", page: "invoices", text: `${drafts.length} facture${drafts.length > 1 ? "s" : ""} en brouillon à émettre` });
  }
  if (has("quotes")) {
    const waiting = visible("quotes").filter((q) => q.status === "Envoyé");
    if (waiting.length) todo.push({ tone: "warn", icon: "quotes", page: "quotes", text: role === "client" ? `${waiting.length} devis à accepter` : `${waiting.length} devis en attente de réponse`, detail: money(waiting.reduce((t, q) => t + (Number(q.amount) || 0), 0)) });
  }
  if (has("time") && can([...hr, "manager"])) {
    const pending = visible("time").filter((t) => t.status === "En attente");
    if (pending.length) todo.push({ tone: "warn", icon: "time", page: "time", text: `${pending.length} saisie${pending.length > 1 ? "s" : ""} d’heures à valider` });
  }
  if (has("absences") && can([...hr, "manager"])) {
    const pending = visible("absences").filter((a) => a.status === "En attente");
    if (pending.length) todo.push({ tone: "warn", icon: "absences", page: "absences", text: `${pending.length} demande${pending.length > 1 ? "s" : ""} d’absence à approuver` });
  }
  if (has("inventory") && role !== "employee") {
    const low = visible("inventory").filter((x) => Number(x.min) > 0 && Number(x.stock) <= Number(x.min));
    if (low.length) todo.push({ tone: "info", icon: "inventory", page: "inventory", text: `${low.length} article${low.length > 1 ? "s" : ""} à recommander`, detail: low.slice(0, 2).map((x) => x.name).join(", ") });
  }
  if (has("planning") && role !== "client") {
    const mine = visible("planning").filter((x) => x.date === todayIso && (role !== "employee" || same(x.employeeId, profile.employee_id)));
    if (mine.length)
      todo.push({ tone: "ok", icon: "planning", page: "planning", text: role === "employee" ? `Aujourd’hui : ${mine.map((x) => `${x.start}–${x.end} ${name("projects", x.project)}`).join(" · ")}` : `${mine.length} intervention${mine.length > 1 ? "s" : ""} prévue${mine.length > 1 ? "s" : ""} aujourd’hui` });
  }
  const todoHtml = `<section class="card home-todo" aria-label="À faire"><h2 class="home-title">À faire</h2>${
    todo.length
      ? `<ul class="home-todo-list">${todo
          .map((t) => `<li><button type="button" class="home-todo-item tone-${t.tone}" data-shortcut="${t.page}"><span class="home-todo-icon">${navigationIcon(t.icon)}</span><span class="home-todo-text"><b>${esc(t.text)}</b>${t.detail ? `<small>${esc(t.detail)}</small>` : ""}</span><span class="home-todo-go" aria-hidden="true">›</span></button></li>`)
          .join("")}</ul>`
      : '<p class="home-empty">Rien n’attend pour l’instant.</p>'
  }</section>`;

  // A few numbers that matter.
  const figures = [];
  const openBalance = visible("invoices").filter(open).reduce((t, i) => t + (Number(i.amount) || 0) - (Number(i.paid) || 0), 0);
  const running = visible("projects").filter((p) => p.status === "En cours").length;
  if (role === "client") {
    figures.push(["Mes chantiers", visible("projects").length]);
    figures.push(["Solde à payer", money(openBalance)]);
  } else if (role === "employee") {
    const e = find("employees", profile.employee_id);
    const monthHours = visible("time").filter((t) => (t.date || "") >= startOfMonth && same(t.employeeId, profile.employee_id)).reduce((t, x) => t + (Number(x.hours) || 0), 0);
    figures.push(["Mes heures ce mois", monthHours.toFixed(1) + " h"]);
    figures.push(["Vacances restantes", (e?.vacation ?? 0) + " jours"]);
    figures.push(["Mes chantiers", visible("projects").length]);
  } else {
    if (can(fin)) figures.push(["À encaisser", money(openBalance)]);
    if (can(fin)) figures.push(["Facturé ce mois", money(visible("invoices").filter((i) => (i.date || "") >= startOfMonth && i.status !== "Brouillon").reduce((t, i) => t + (Number(i.amount) || 0), 0))]);
    figures.push(["Chantiers en cours", running]);
    if (!can(fin) && has("time")) figures.push(["Heures ce mois", visible("time").filter((t) => (t.date || "") >= startOfMonth).reduce((t, x) => t + (Number(x.hours) || 0), 0).toFixed(1) + " h"]);
  }
  const figuresHtml = `<section class="home-figures" aria-label="Chiffres">${figures.map(([label, value]) => `<article class="card home-figure"><span>${esc(label)}</span><b>${esc(value)}</b></article>`).join("")}</section>`;

  const intro = `<section class="workspace-welcome"><div><p class="eyebrow">${esc(new Date().toLocaleDateString("fr-CH", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Zurich" }))}</p><h1>Bonjour, ${first}.</h1></div></section>`;
  const projectsHtml =
    has("projects") && visible("projects").length
      ? heading(role === "client" ? "Mes chantiers" : role === "employee" ? "Mes chantiers" : "Chantiers en cours") + projectRows(visible("projects").filter((p) => role === "client" || p.status !== "Terminé").slice(0, 6))
      : "";
  return (
    intro +
    quickHtml +
    `<div class="home-columns">${todoHtml}${figuresHtml}</div>` +
    (role === "employee" ? clockView() : "") +
    projectsHtml +
    '<div id="homeMore" class="home-more"></div>'
  );
}
function clockView() {
  if (!profile.employee_id) return "";
  const c = state.clocks[0];
  return `<article class="card section"><h3>Mon pointage</h3><p>${c ? `Commencé le ${esc(new Date(c.startedAt).toLocaleString("fr-CH"))} · ${c.pauseAt ? "En pause" : "En cours"}` : "Aucun pointage actif"}</p>${c ? btn(c.pauseAt ? "Reprendre" : "Pause", c.pauseAt ? "clock.resume" : "clock.pause") + " " + btn("Terminer", "clock.stop", "", "danger") : `<label for="clockProject">Chantier</label><select id="clockProject">${options("projects")}</select>${btn("Commencer", "clock.start", "", "primary")}`}</article>`;
}
function timeView() {
  return (
    clockView() +
    heading(
      "Heures enregistrées",
      (can([...hr, "manager", "employee"])
        ? btn("Ajouter des heures", "time-add", "", "primary") + " "
        : "") + btn("Exporter CSV", "export", "time"),
    ) +
    table(
      ["Salarié", "Chantier", "Début", "Fin", "Pause", "Heures", "Statut", ""],
      visible("time").map((t) => [
        esc(name("employees", t.employeeId)),
        esc(name("projects", t.project)),
        esc(
          t.startedAt
            ? new Date(t.startedAt).toLocaleString("fr-CH", {
                timeZone: "Europe/Zurich",
              })
            : t.start,
        ),
        esc(
          t.endedAt
            ? new Date(t.endedAt).toLocaleString("fr-CH", {
                timeZone: "Europe/Zurich",
              })
            : t.end,
        ),
        esc(t.break) + " min",
        Number(t.hours).toFixed(2),
        badge(t.status),
        (can([...hr, "manager"]) && t.status !== "Validé"
          ? btn("Valider", "time.approve", t.id)
          : "") +
          " " +
          deleteRecordButton("time", t),
      ]),
    )
  );
}
let planningDate = today(),
  // "" = automatic: list on phones, weekly grid elsewhere, until the user picks a view.
  planningMode = "",
  planningEmployee = "";
function manualTimeForm() {
  formShell(
    [
      ...(profile.role === "employee"
        ? []
        : [["employeeId", "Salarié", "@employees"]]),
      ["project", "Chantier", "@projects"],
      ["date", "Date", "date", today()],
      ["start", "Début", "time", "08:00"],
      ["end", "Fin", "time", "12:00"],
      ["break", "Pause (minutes)", "number", "0"],
      ["note", "Commentaire", "textarea?"],
    ],
    "time.add",
    '<p class="muted">Horaires suisses. La pause est déduite automatiquement. Les heures seront à valider. Pour une nuit, saisissez une ligne par jour.</p>',
    "Ajouter des heures",
  );
  if (profile.role === "employee")
    $("entityForm").insertAdjacentHTML(
      "beforeend",
      `<input type="hidden" id="f_employeeId" name="employeeId" value="${esc(profile.employee_id)}">`,
    );
  planningProjects();
}
function planningDay(value, offset = 0) {
  const d = new Date(value + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function planningWeek() {
  const day = new Date(planningDate + "T12:00:00Z").getUTCDay();
  const start = planningDay(planningDate, -((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => planningDay(start, i));
}
function planningForm(employeeId = "", day = planningDate, copy = null) {
  newForm("planning");
  if (employeeId) $("f_employeeId").value = employeeId;
  planningProjects();
  $("f_date").value = day;
  $("f_start").value = copy?.start || "08:00";
  $("f_end").value = copy?.end || "12:00";
  if (copy) {
    $("f_project").value = copy.project;
    $("f_location").value = copy.location || "";
  }
}
function planningProjects() {
  const employee = find("employees", $("f_employeeId").value);
  const previous = $("f_project").value;
  const projects = visible("projects").filter((p) =>
    [employee?.company, ...(employee?.companies || [])].includes(p.company),
  );
  $("f_project").innerHTML = projects.length
    ? projects
        .map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`)
        .join("")
    : '<option value="">Aucun chantier pour cette entreprise</option>';
  if (projects.some((p) => same(p.id, previous)))
    $("f_project").value = previous;
}
function planningView() {
  const days = planningWeek();
  const staff = visible("employees").filter(
    (e) => profile.role !== "employee" || same(e.id, profile.employee_id),
  );
  if (!staff.some((e) => same(e.id, planningEmployee))) planningEmployee = "";
  const selected = staff.filter(
    (e) => !planningEmployee || same(e.id, planningEmployee),
  );
  const entries = visible("planning")
    .filter(
      (p) =>
        p.date >= days[0] &&
        p.date <= days[6] &&
        selected.some((e) => same(e.id, p.employeeId)),
    )
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start),
    );
  const hours = (rows) =>
    rows
      .reduce((sum, p) => {
        const minutes = (t) =>
          Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        return sum + (minutes(p.end) - minutes(p.start)) / 60;
      }, 0)
      .toLocaleString("fr-CH", { maximumFractionDigits: 2 });
  const mode = planningMode || (compactLayout.matches ? "list" : "week");
  const navButton = (id, label, html) =>
    `<button type="button" class="btn secondary planning-nav-btn" data-action="planning-nav" data-id="${id}" aria-label="${label}" title="${label}">${html}</button>`;
  const modeButton = (id, label) =>
    `<button type="button" class="btn ${mode === id ? "primary" : "secondary"}" data-action="planning-mode" data-id="${id}" aria-pressed="${mode === id}">${label}</button>`;
  const controls = `<div class="planning-controls"><div class="planning-nav">${navButton("-7", "Semaine précédente", '‹<span class="planning-nav-label"> Semaine précédente</span>')}${btn("Aujourd’hui", "planning-nav", "today")}${navButton("7", "Semaine suivante", '<span class="planning-nav-label">Semaine suivante </span>›')}</div><label>Date<input id="planningDate" type="date" value="${planningDate}"></label><label>Salarié<select id="planningEmployee"><option value="">Toute l’équipe</option>${staff.map((e) => `<option value="${esc(e.id)}" ${same(e.id, planningEmployee) ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select></label><div class="planning-mode" role="group" aria-label="Affichage du planning">${modeButton("week", "Par salarié")}${modeButton("list", "Liste")}</div></div><p class="muted">Du ${date(days[0])} au ${date(days[6])} · ${selected.length} ${selected.length > 1 ? "salariés" : "salarié"} · ${hours(entries)} h planifiées, pauses non déduites.</p>`;
  const calendar = `<div class="planning-scroll" role="region" aria-label="Calendrier hebdomadaire par salarié" tabindex="0"><table class="planning-calendar"><caption>Planning du ${date(days[0])} au ${date(days[6])}</caption><thead><tr><th scope="col">Salarié / heures</th>${days.map((d, i) => `<th scope="col" class="${d === today() ? "planning-today" : ""}">${["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"][i]} ${date(d)}</th>`).join("")}</tr></thead><tbody>${selected
    .map(
      (e) =>
        `<tr><th scope="row">${esc(e.name)}<small>${hours(entries.filter((p) => same(p.employeeId, e.id)))} h planifiées</small></th>${days
          .map((d) => {
            const shifts = entries.filter(
              (p) => same(p.employeeId, e.id) && p.date === d,
            );
            const absent = state.absences.some(
              (a) =>
                same(a.employeeId, e.id) &&
                a.status === "Approuvée" &&
                a.from <= d &&
                a.to >= d,
            );
            return `<td class="${d === today() ? "planning-today" : ""}">${absent ? '<div class="planning-absence">Absent · validé</div>' : ""}${shifts.map((p) => `<button class="planning-shift" data-action="planning-detail" data-id="${esc(p.id)}"><b>${esc(p.start)}–${esc(p.end)}</b><span>${esc(name("projects", p.project))}</span>${p.location ? `<small>${esc(p.location)}</small>` : ""}</button>`).join("")}${!shifts.length && !absent ? '<span class="sr-only">Sans affectation</span>' : ""}${can(ops) && !absent ? `<button class="planning-add${shifts.length ? "" : " planning-add-empty"}" data-action="planning-slot" data-employee="${esc(e.id)}" data-date="${d}" aria-label="Planifier ${esc(e.name)} le ${date(d)}" title="Planifier">${uiIcon("plus")}</button>` : ""}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
  return (
    heading(
      "Planning de l’équipe",
      (can(ops) ? btn("Planifier", "new", "planning", "primary") + " " : "") +
        btn("Exporter CSV", "export", "planning"),
    ) +
    controls +
    (() => {
      // « Tournée du jour »: today's stops of one person, in order, in Google Maps.
      const who = profile.role === "employee" ? profile.employee_id : planningEmployee;
      const stops = who ? todayStops(who) : [];
      return `<div class="go-bar">${stops.length ? `<button type="button" class="btn primary go-btn" data-action="go-tour" data-id="${esc(who)}">${uiIcon("go")}<span>Tournée du jour (${stops.length} ${stops.length > 1 ? "arrêts" : "arrêt"})</span></button>` : who ? '<span class="muted">Aucune adresse prévue aujourd’hui.</span>' : '<span class="muted">Choisissez un salarié pour sa tournée du jour.</span>'}<button type="button" class="link-btn" data-action="go-app-reset">${navApp() ? "Itinéraires : " + esc(NAV_APPS[navApp()]) + " · Changer d’application" : "Itinéraires : choisir l’application"}</button></div>`;
    })() +
    (selected.length
      ? mode === "week"
        ? calendar
        : !entries.length
          ? '<article class="card empty">' + uiIcon("calendar") + '<strong>Aucune intervention planifiée cette semaine.</strong><span>Changez de semaine ou ajoutez une affectation avec « Planifier ».</span></article>'
          : table(
            ["Date", "Début", "Fin", "Salarié", "Chantier", "Lieu", ""],
            entries.map((p) => [
              date(p.date),
              esc(p.start),
              esc(p.end),
              esc(name("employees", p.employeeId)),
              esc(name("projects", p.project)),
              esc(p.location),
              btn("Détails", "planning-detail", p.id) + " " + goButton(planningAddress(p)),
            ]),
          )
      : '<p class="empty">Aucun salarié dans cette vue.</p>') +
    '<p class="muted">Vue « Par salarié » : une ligne par salarié ; cliquez sur un créneau pour voir ses détails, ou sur + pour ajouter une affectation. Sur téléphone, la liste s’affiche par défaut. Les absences validées et les chevauchements sont bloqués à l’enregistrement.</p>'
  );
}
function absenceView() {
  return (
    heading(
      "Absences",
      can([...hr, "employee"])
        ? btn("Demander une absence", "absence-form", "", "primary")
        : "",
    ) +
    table(
      ["Salarié", "Type", "Du", "Au", "Jours ouvrés", "État", ""],
      visible("absences").map((a) => [
        esc(name("employees", a.employeeId)),
        esc(a.type),
        date(a.from),
        date(a.to),
        esc(a.days),
        badge(a.status),
        (can(hr) && a.status === "En attente"
          ? btn("Approuver", "absence.approve", a.id) +
            " " +
            btn("Refuser", "absence.reject", a.id)
          : "") +
          " " +
          deleteRecordButton("absences", a),
      ]),
    )
  );
}
let showArchivedFinance = false;
function financeView(k) {
  const quote = k === "quotes";
  return (
    heading(
      quote ? "Devis" : "Factures",
      can(fin)
        ? btn("Créer", "new", k, "primary") +
            " " +
            (quote && hasTrade("demenagement") ? `<button type="button" class="btn primary" data-moving-action="open">Devis déménagement</button> ` : "") +
            btn("Exporter CSV", "export", k) +
            " " +
            btn("Paramètres de facturation", "billing-settings") +
            " " +
            btn(
              showArchivedFinance
                ? "Masquer les archives"
                : "Afficher les archives",
              "finance-archives",
            )
        : "",
    ) +
    table(
      [
        "Numéro",
        "Client",
        "Objet",
        "Montant",
        "Échéance",
        ...(quote ? [] : ["Payé", "Solde"]),
        "Statut",
        "",
      ],
      visible(k)
        .filter((r) => showArchivedFinance || !r.archivedAt)
        .map((r) => [
          esc(r.id),
          esc(name("clients", r.clientId)),
          esc(r.title),
          money(r.amount),
          date(quote ? r.valid : r.due),
          ...(quote ? [] : [money(r.paid), money(r.amount - (r.paid || 0))]),
          badge(
            !quote &&
              r.status !== "Brouillon" &&
              r.status !== "Payée" &&
              r.due < today()
              ? "En retard"
              : quote && r.status === "Émise" && r.valid && r.valid < today()
                ? "Expiré"
                : r.status,
          ),
          btn("Ouvrir", quote ? "quote" : "invoice", r.id) +
            (r.archivedAt ? " · Archivé" : "") +
            (can(fin)
              ? " " +
                (r.status === "Brouillon"
                  ? btn("Supprimer", "finance-delete", k + ":" + r.id, "danger")
                  : btn(
                      r.archivedAt ? "Restaurer" : "Archiver",
                      "finance-archive",
                      k + ":" + r.id,
                    ) +
                    (quoteDeletable(k, r)
                      ? " " + btn("Supprimer", "finance-delete", k + ":" + r.id, "danger")
                      : ""))
              : ""),
        ]),
    )
  );
}
// Issued, expired or refused quotes can be deleted; accepted ones are linked to a project.
const quoteDeletable = (k, r) => k === "quotes" && !["Brouillon", "Accepté"].includes(r.status);
function documentsView() {
  return (
    heading(
      "Documents",
      profile.role !== "client"
        ? btn("Ajouter un fichier", "document-form", "", "primary")
        : "",
    ) +
    table(
      ["Fichier", "Dossier", "Taille", "Date", ""],
      visible("documents").map((d) => [
        esc(d.name),
        esc(
          d.project ||
            name(
              d.employeeId ? "employees" : "clients",
              d.employeeId || d.clientId,
            ),
        ),
        Math.ceil(d.size / 1024) + " Ko",
        date(d.createdAt),
        btn("Télécharger", "download", d.id) +
          " " +
          deleteRecordButton("documents", d),
      ]),
    )
  );
}
function chatAvatar(person, extra = "") {
  const label = person?.name || "—",
    photo = person?.photo || "";
  return photo
    ? `<img class="chat-avatar ${esc(extra)}" src="${esc(photo)}" alt="" width="48" height="48" loading="lazy">`
    : `<span class="chat-avatar chat-avatar-initial ${esc(extra)}" aria-hidden="true">${esc(label.slice(0, 1).toUpperCase())}</span>`;
}
function chatTime(value) {
  return value
    ? new Date(value).toLocaleTimeString("fr-CH", {
        timeZone: "Europe/Zurich",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}
function chatDate(value) {
  return new Date(value).toLocaleDateString("fr-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
function chatRead(m) {
  return (m.readBy || []).some((id) => same(id, profile.id));
}
function chatMessagePreview(m) {
  if (!m) return "Commencer une conversation";
  const prefix = same(m.senderId, profile.id) ? "Vous : " : "";
  if (m.deletedForAll) return prefix + "🚫 Message supprimé";
  if (m.system) return "⚙ " + (m.text || "Activité du chantier");
  if (m.encryption) return prefix + "🔐 Message chiffré";
  if (m.sharedRef) return prefix + "📄 " + (m.sharedRef.title || m.sharedRef.id);
  if (m.text) return prefix + m.text;
  if (m.attachment?.kind === "image") return prefix + "📷 Photo";
  if (m.attachment?.kind === "video") return prefix + "🎬 Vidéo";
  if (m.attachment?.kind === "audio") return prefix + "🎤 Message vocal";
  return prefix + "📎 " + (m.attachment?.name || "Fichier");
}
function chatAttachmentHtml(m) {
  if (!m.attachment || m.deletedForAll) return "";
  const label = esc(m.attachment.name || "Pièce jointe");
  if (m.attachment.encrypted)
    return `<button type="button" class="chat-attachment-link encrypted-attachment" data-encrypted-attachment="${esc(m.id)}">🔐 ${label} · déchiffrement…</button>`;
  if (m.attachment.kind === "image")
    return `<button type="button" class="chat-media-button" data-action="chat-open-attachment" data-id="${esc(m.id)}"><img data-chat-media="${esc(m.id)}" alt="${label}" class="chat-image-preview"><span>📷 ${label}</span></button>`;
  if (m.attachment.kind === "video")
    return `<div class="chat-video-wrap"><video controls playsinline preload="metadata" data-chat-media="${esc(m.id)}"></video><button type="button" class="chat-attachment-link" data-action="chat-open-attachment" data-id="${esc(m.id)}">🎬 ${label}</button></div>`;
  if (m.attachment.kind === "audio")
    return `<div class="chat-audio-wrap"><audio controls preload="none" data-chat-media="${esc(m.id)}"></audio><button type="button" class="chat-attachment-link" data-action="chat-open-attachment" data-id="${esc(m.id)}">🎤 ${label}</button></div>`;
  return `<button type="button" class="chat-attachment-link" data-action="chat-open-attachment" data-id="${esc(m.id)}">📎 ${label} · ${Math.ceil((m.attachment.size || 0) / 1024)} Ko</button>`;
}
function chatReplyHtml(m, messages) {
  if (!m.replyToId) return "";
  const quoted = messages.find((x) => same(x.id, m.replyToId));
  if (!quoted) return "";
  return `<button type="button" class="chat-quote" data-action="chat-jump" data-id="${esc(quoted.id)}"><b>${esc(quoted.sender || "Message")}</b><span>${esc((quoted.text || chatMessagePreview(quoted)).slice(0, 120))}</span></button>`;
}
async function hydrateChatAttachments() {
  if (!token) return;
  for (const node of document.querySelectorAll("[data-chat-media]")) {
    const id = node.dataset.chatMedia;
    if (node.dataset.loaded) continue;
    node.dataset.loaded = "1";
    try {
      const r = await fetch("/api/state/messages/" + encodeURIComponent(id) + "/attachment", {
        credentials: "same-origin",
      });
      if (!r.ok) throw new Error("Pièce jointe inaccessible.");
      const blob = await r.blob(),
        objectUrl = URL.createObjectURL(blob);
      node.src = objectUrl;
      node.addEventListener("load", () => {
        if (node.tagName === "IMG") node.classList.add("loaded");
      }, { once: true });
    } catch {
      node.replaceWith(document.createTextNode("Pièce jointe indisponible"));
    }
  }
}
async function markChatRead() {
  if (
    !token ||
    pending ||
    page !== "messages" ||
    window.SGOAccountPreferences?.privacy?.readReceipts === false
  )
    return;
  const payload = selectedThreadId
    ? { threadId: selectedThreadId }
    : { recipientId: selectedRecipient };
  if (!payload.threadId && !payload.recipientId) return;
  const unread = state.messages.some(
    (m) =>
      !same(m.senderId, profile.id) &&
      !chatRead(m) &&
      (payload.threadId
        ? same(m.threadId, payload.threadId)
        : !m.threadId && same(m.senderId, payload.recipientId)),
  );
  if (!unread) return;
  try {
    const out = await api("state/messages/read", {
      action: "message.read",
      payload,
      revision,
      requestId: crypto.randomUUID(),
    });
    if (Number.isSafeInteger(out.revision)) revision = out.revision;
    if (messageStats[chatKey()]) messageStats[chatKey()].unread = 0;
    for (const m of state.messages) {
      const belongs = payload.threadId
        ? same(m.threadId, payload.threadId)
        : !m.threadId && same(m.senderId, payload.recipientId);
      if (belongs && !same(m.senderId, profile.id))
        m.readBy = [...new Set([...(m.readBy || []).map(String), String(profile.id)])];
    }
    render();
  } catch (e) {
    if (e.status !== 409) notice(e.message);
  }
}
function threadForm(type = "group", projectId = "") {
  const projects = visible("projects");
  modal(
    type === "project" ? "Discussion de chantier" : "Nouveau groupe",
    `<form id="entityForm" data-kind="message.thread">
      <label>Nom<input name="name" maxlength="120" required placeholder="${type === "project" ? "Discussion chantier" : "Nom du groupe"}"></label>
      <label>Type<select name="type"><option value="group" ${type === "group" ? "selected" : ""}>Groupe</option><option value="project" ${type === "project" ? "selected" : ""}>Chantier</option></select></label>
      <label>Chantier<select name="projectId"><option value="">Aucun</option>${projects.map((p) => `<option value="${esc(p.id)}" ${same(p.id, projectId) ? "selected" : ""}>${esc(p.title)}</option>`).join("")}</select></label>
      <fieldset class="chat-participants"><legend>Participants</legend>${contacts.map((c) => `<label><input type="checkbox" name="participants" value="${esc(c.id)}"> ${esc(c.name)} · ${esc(roles[c.role] || c.role)}</label>`).join("")}</fieldset>
      <p id="formError" class="error" role="alert"></p>
      <div class="form-actions">${btn("Annuler", "close-modal")}<button type="submit" class="btn primary">Créer</button></div>
    </form>`,
  );
}
function ensureCallOverlay() {
  let overlay = $("callOverlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "callOverlay";
  overlay.className = "call-overlay hidden";
  overlay.innerHTML = `
    <div class="call-card">
      <div class="call-avatar" id="callAvatar">${uiIcon("phone")}</div>
      <div id="callVideoStage" class="call-video-stage hidden">
        <video id="remoteCallVideo" autoplay playsinline muted></video>
        <video id="localCallVideo" autoplay playsinline muted></video>
      </div>
      <h3 id="callName">Appel</h3>
      <p id="callState">Connexion…</p>
      <div class="call-timer hidden" id="callTimer">00:00</div>
      <div class="call-controls">
        <button type="button" id="callReject" class="call-control danger hidden" data-action="call-reject" aria-label="Refuser l'appel">${uiIcon("hangup")}</button>
        <button type="button" id="callAccept" class="call-control accept hidden" data-action="call-accept" aria-label="Accepter l'appel">${uiIcon("phone")}</button>
        <button type="button" id="callMute" class="call-control hidden" data-action="call-mute" aria-label="Couper le micro">${uiIcon("mic")}</button>
        <button type="button" id="callCamera" class="call-control hidden" data-action="call-camera" aria-label="Couper la caméra">${uiIcon("video")}</button>
        <button type="button" id="callEnableAudio" class="call-control hidden" data-action="call-enable-audio" aria-label="Activer le son">${uiIcon("volume")}</button>
        <button type="button" id="callHangup" class="call-control danger hidden" data-action="call-hangup" aria-label="Raccrocher">${uiIcon("hangup")}</button>
      </div>
      <audio id="remoteCallAudio" autoplay playsinline></audio>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}
function callDisplayName(call) {
  if (!call) return "Appel";
  return same(call.callerId, profile?.id) ? call.calleeName : call.callerName;
}
function setCallUi(name, status, mode = "active") {
  ensureCallOverlay();
  $("callName").textContent = name || "Appel";
  $("callState").textContent = status;
  $("callOverlay").classList.remove("hidden");
  $("callAccept").classList.toggle("hidden", mode !== "incoming");
  $("callReject").classList.toggle("hidden", mode !== "incoming");
  const call = activeCall || incomingCall,
    isVideo = call?.callType === "video";
  $("callMute").classList.toggle("hidden", mode === "incoming" || mode === "ended");
  $("callCamera").classList.toggle("hidden", !isVideo || mode === "incoming" || mode === "ended");
  $("callHangup").classList.toggle("hidden", mode === "incoming" || mode === "ended");
  $("callTimer").classList.toggle("hidden", mode !== "connected");
  $("callVideoStage").classList.toggle("hidden", !isVideo);
  $("callAvatar").classList.toggle("hidden", isVideo);
  $("callEnableAudio").classList.toggle("hidden", !callAudioBlocked || mode === "incoming" || mode === "ended");
}
function hideCallUi() {
  $("callOverlay")?.classList.add("hidden");
  if ($("remoteCallAudio")) {
    $("remoteCallAudio").pause?.();
    $("remoteCallAudio").srcObject = null;
  }
  for (const id of ["remoteCallVideo", "localCallVideo"])
    if ($(id)) {
      $(id).pause?.();
      $(id).srcObject = null;
    }
  callAudioBlocked = false;
}
function friendlyMediaError(error, purpose = "micro") {
  if (!error) return "Le microphone est indisponible.";
  if (error.name === "NotAllowedError" || error.name === "SecurityError")
    return "Autorisation du microphone refusée. Autorisez le micro dans les réglages du navigateur puis réessayez.";
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")
    return "Aucun microphone n’a été détecté sur cet appareil.";
  if (error.name === "NotReadableError" || error.name === "TrackStartError")
    return "Le microphone est déjà utilisé ou inaccessible. Fermez les autres applications qui l’utilisent puis réessayez.";
  return purpose === "vocal"
    ? "Impossible d’enregistrer le message vocal."
    : "Impossible d’accéder au microphone.";
}
async function playRemoteAudio() {
  const audio = $("remoteCallAudio");
  if (!audio?.srcObject) return;
  try {
    await audio.play();
    callAudioBlocked = false;
    $("callEnableAudio")?.classList.add("hidden");
  } catch {
    callAudioBlocked = true;
    $("callEnableAudio")?.classList.remove("hidden");
    if ($("callState") && activeCall?.peer?.connectionState === "connected")
      $("callState").textContent = "En appel · touchez le haut-parleur pour entendre";
  }
}
function unlockRingtoneAudio() {
  if (!window.AudioContext) return;
  try {
    ringAudioContext ||= new AudioContext();
    if (ringAudioContext.state === "suspended")
      ringAudioContext.resume().catch(() => {});
  } catch {}
}
function stopRingtone() {
  clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  navigator.vibrate?.(0);
}
function beepRingtone() {
  if (ringtoneTimer || !window.AudioContext) return;
  const beep = () => {
    try {
      ringAudioContext ||= new AudioContext();
      if (ringAudioContext.state === "suspended")
        ringAudioContext.resume().catch(() => {});
      const ctx = ringAudioContext,
        osc = ctx.createOscillator(),
        gain = ctx.createGain();
      osc.frequency.value = 640;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.035, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.36);
    } catch {}
  };
  beep();
  navigator.vibrate?.([500, 300, 500, 300, 500]);
  ringtoneTimer = setInterval(beep, 2200);
}
function formatCallTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0"),
    sec = String(seconds % 60).padStart(2, "0");
  return m + ":" + sec;
}
function startCallTimer() {
  if (!activeCall) return;
  activeCall.connectedAt ||= Date.now();
  clearInterval(callStatusTimer);
  callStatusTimer = setInterval(() => {
    if (!activeCall?.connectedAt || !$("callTimer")) return;
    $("callTimer").textContent = formatCallTime(
      Math.floor((Date.now() - activeCall.connectedAt) / 1000),
    );
  }, 1000);
}
async function postIceCandidate(candidate) {
  if (!candidate) return;
  if (!activeCall?.id) {
    pendingIceCandidates.push(candidate);
    return;
  }
  await api("state/calls/" + encodeURIComponent(activeCall.id) + "/candidates", {
    candidate: candidate.toJSON ? candidate.toJSON() : candidate,
  }).catch(() => {});
}
async function flushIceCandidates() {
  const queued = pendingIceCandidates.splice(0);
  for (const candidate of queued) await postIceCandidate(candidate);
}
async function loadIceServers() {
  if (rtcIceServers) return rtcIceServers;
  try {
    const config = await api("state/calls/config");
    rtcIceServers =
      Array.isArray(config.iceServers) && config.iceServers.length
        ? config.iceServers
        : [{ urls: "stun:stun.l.google.com:19302" }];
  } catch {
    rtcIceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  }
  return rtcIceServers;
}
async function makePeer(callType = "audio") {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
    throw new Error("Les appels ne sont pas disponibles sur cet appareil.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video:
        callType === "video"
          ? {
              facingMode: "user",
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
    });
    if (callType === "video") {
      ensureCallOverlay();
      $("localCallVideo").srcObject = stream;
      $("localCallVideo").play().catch(() => {});
    }
    const peer = new RTCPeerConnection({
      iceServers: await loadIceServers(),
      iceCandidatePoolSize: 2,
    });
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    peer.onicecandidate = (e) => {
      if (e.candidate) postIceCandidate(e.candidate);
    };
    peer.ontrack = (e) => {
      ensureCallOverlay();
      const remoteStream = e.streams[0] || new MediaStream([e.track]),
        audio = $("remoteCallAudio");
      audio.srcObject = remoteStream;
      if (callType === "video") {
        $("remoteCallVideo").srcObject = remoteStream;
        $("remoteCallVideo").play().catch(() => {});
      }
      playRemoteAudio();
    };
    peer.onconnectionstatechange = () => {
      if (!activeCall || activeCall.peer !== peer) return;
      if (peer.connectionState === "connected") {
        setCallUi(callDisplayName(activeCall), "En appel", "connected");
        startCallTimer();
        playRemoteAudio();
      } else if (peer.connectionState === "failed") {
        endCurrentCall(true).catch(() => finishCallLocal("Connexion impossible."));
      } else if (peer.connectionState === "disconnected") {
        setCallUi(callDisplayName(activeCall), "Reconnexion…", "active");
      }
    };
    return { peer, stream };
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    const e = new Error(
      error?.message?.includes("appareil")
        ? error.message
        : friendlyMediaError(error),
    );
    e.name = error?.name || "MediaError";
    throw e;
  }
}
async function flushRemoteIceCandidates() {
  if (!activeCall?.peer?.remoteDescription) return;
  const queued = remoteIceQueue.splice(0);
  for (const candidate of queued) {
    try {
      await activeCall.peer.addIceCandidate(candidate);
    } catch {}
  }
}
async function receiveRemoteCandidates() {
  if (!activeCall?.id || !activeCall.peer) return;
  const out = await api(
    "state/calls/" +
      encodeURIComponent(activeCall.id) +
      "/candidates?after=" +
      callCandidateCursor,
  );
  for (const row of out.candidates || []) {
    callCandidateCursor = Math.max(callCandidateCursor, Number(row.id) || 0);
    if (!activeCall.peer.remoteDescription) {
      remoteIceQueue.push(row.candidate);
      continue;
    }
    try {
      await activeCall.peer.addIceCandidate(row.candidate);
    } catch {}
  }
}
function stopCallMedia() {
  if (activeCall?.stream)
    activeCall.stream.getTracks().forEach((track) => track.stop());
  try {
    activeCall?.peer?.close();
  } catch {}
  clearInterval(callStatusTimer);
  callStatusTimer = null;
  stopRingtone();
}
function finishCallLocal(message = "Appel terminé.") {
  stopCallMedia();
  const name = callDisplayName(activeCall || incomingCall);
  activeCall = null;
  incomingCall = null;
  callCandidateCursor = 0;
  pendingIceCandidates = [];
  remoteIceQueue = [];
  callPollBusy = false;
  callAudioBlocked = false;
  clearTimeout(callEndUiTimer);
  setCallUi(name, message, "ended");
  if ($("callMute")) $("callMute").classList.add("hidden");
  if ($("callHangup")) $("callHangup").classList.add("hidden");
  callEndUiTimer = setTimeout(() => {
    if (!activeCall && !incomingCall) hideCallUi();
  }, 1800);
}
async function endCurrentCall(send = true) {
  const id = activeCall?.id || incomingCall?.id;
  if (send && id)
    await api("state/calls/" + encodeURIComponent(id) + "/end", {}).catch(() => {});
  finishCallLocal();
}
async function startDirectCall(contactId, callType = "audio") {
  if (chatRecorder?.state === "recording") cancelChatRecording();
  if (activeCall || incomingCall)
    throw new Error("Un appel est déjà en cours.");
  const contact = contacts.find((c) => same(c.id, contactId));
  if (!contact) throw new Error("Contact introuvable.");
  clearTimeout(callEndUiTimer);
  setCallUi(contact.name, "Préparation de l’appel…", "active");
  try {
    const { peer, stream } = await makePeer(callType);
    activeCall = {
      id: "",
      callType,
      callerId: profile.id,
      calleeId: contact.id,
      callerName: profile.name,
      calleeName: contact.name,
      peer,
      stream,
      answerApplied: false,
    };
    const offer = await peer.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: callType === "video",
    });
    await peer.setLocalDescription(offer);
    const out = await api("state/calls/start", {
      recipientId: contact.id,
      callType,
      offer: peer.localDescription,
    });
    activeCall.id = out.id;
    callCandidateCursor = 0;
    remoteIceQueue = [];
    await flushIceCandidates();
    setCallUi(contact.name, "Appel en cours…", "active");
  } catch (e) {
    finishCallLocal(
      e.name === "NotAllowedError" || e.name === "SecurityError"
        ? "Microphone refusé."
        : "Appel impossible.",
    );
    throw e;
  }
}
async function startAudioCall(contactId) {
  return startDirectCall(contactId, "audio");
}
async function startVideoCall(contactId) {
  return startDirectCall(contactId, "video");
}
async function acceptIncomingCall() {
  if (!incomingCall) return;
  const call = incomingCall;
  stopRingtone();
  clearTimeout(callEndUiTimer);
  setCallUi(call.callerName, "Connexion…", "active");
  try {
    const { peer, stream } = await makePeer(call.callType || "audio");
    activeCall = { ...call, callType: call.callType || "audio", peer, stream, answerApplied: true };
    incomingCall = null;
    callCandidateCursor = 0;
    remoteIceQueue = [];
    await peer.setRemoteDescription(call.offer);
    await flushRemoteIceCandidates();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await api("state/calls/" + encodeURIComponent(call.id) + "/answer", {
      answer: peer.localDescription,
    });
    await flushIceCandidates();
    setCallUi(call.callerName, "Connexion…", "active");
  } catch (e) {
    await api("state/calls/" + encodeURIComponent(call.id) + "/reject", {}).catch(() => {});
    finishCallLocal(
      e.name === "NotAllowedError" || e.name === "SecurityError"
        ? "Microphone refusé."
        : "Appel impossible.",
    );
    throw e;
  }
}
async function rejectIncomingCall() {
  if (!incomingCall) return;
  stopRingtone();
  const id = incomingCall.id;
  await api("state/calls/" + encodeURIComponent(id) + "/reject", {}).catch(
    () => {},
  );
  finishCallLocal("Appel refusé.");
}
async function pollCallState() {
  if (!token || callPollBusy) return;
  callPollBusy = true;
  try {
    if (activeCall?.id) {
      try {
        const out = await api(
            "state/calls/" + encodeURIComponent(activeCall.id),
          ),
          call = out.call;
        if (["ended", "rejected", "missed"].includes(call.status)) {
          finishCallLocal(
            call.status === "rejected"
              ? "Appel refusé."
              : call.status === "missed"
                ? "Pas de réponse."
                : "Appel terminé.",
          );
          return;
        }
        if (
          same(call.callerId, profile.id) &&
          call.status === "accepted" &&
          call.answer &&
          !activeCall.answerApplied
        ) {
          await activeCall.peer.setRemoteDescription(call.answer);
          activeCall.answerApplied = true;
          await flushRemoteIceCandidates();
          setCallUi(call.calleeName, "Connexion…", "active");
        }
        await receiveRemoteCandidates();
      } catch (e) {
        if (e.status === 404) finishCallLocal();
      }
      return;
    }
    if (incomingCall) {
      try {
        const out = await api(
          "state/calls/" + encodeURIComponent(incomingCall.id),
        );
        if (out.call.status !== "ringing") finishCallLocal("Appel annulé.");
      } catch {
        finishCallLocal("Appel annulé.");
      }
      return;
    }
    try {
      const out = await api("state/calls/pending"),
        call = out.call;
      if (
        call &&
        call.status === "ringing" &&
        same(call.calleeId, profile.id)
      ) {
        incomingCall = call;
        setCallUi(
          call.callerName,
          call.callType === "video"
            ? "Appel vidéo entrant"
            : "Appel audio entrant",
          "incoming",
        );
        beepRingtone();
      }
    } catch {}
  } finally {
    callPollBusy = false;
  }
}
function messagesView() {
  const threads = state.messageThreads || [];
  if (!contacts.length && !threads.length)
    return '<article class="card empty">Aucune discussion disponible. Créez un groupe ou vérifiez les comptes autorisés.</article>';
  if (!selectedThreadId && !contacts.some((c) => same(c.id, selectedRecipient)))
    selectedRecipient = contacts[0] ? String(contacts[0].id) : "";
  if (selectedThreadId && !threads.some((t) => same(t.id, selectedThreadId)))
    selectedThreadId = "";

  const directConversations = contacts.map((contact) => {
      const messages = state.messages
        .filter(
          (m) =>
            !m.threadId &&
            ((same(m.senderId, profile.id) && same(m.recipientId, contact.id)) ||
              (same(m.senderId, contact.id) && same(m.recipientId, profile.id))),
        )
        .sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
      return {
        key: "direct:" + contact.id,
        kind: "direct",
        contact,
        title: contact.name,
        subtitle: roles[contact.role] || contact.role,
        messages,
        last: messages.at(-1),
        unread: messageStats["direct:" + contact.id]?.unread ?? messages.filter((m) => !same(m.senderId, profile.id) && !chatRead(m)).length,
      };
    }),
    threadConversations = threads.map((thread) => {
      const messages = state.messages
        .filter((m) => same(m.threadId, thread.id))
        .sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
      return {
        key: "thread:" + thread.id,
        kind: "thread",
        thread,
        title: thread.name,
        subtitle: thread.type === "project"
          ? "Chantier · " + (find("projects", thread.projectId)?.title || thread.projectId)
          : "Groupe · " + (thread.participants || []).length + " participants",
        messages,
        last: messages.at(-1),
        unread: messageStats["thread:" + thread.id]?.unread ?? messages.filter((m) => !same(m.senderId, profile.id) && !chatRead(m)).length,
      };
    }),
    conversations = [...directConversations, ...threadConversations].sort(
      (x, y) =>
        (y.last ? new Date(y.last.createdAt).getTime() : 0) -
          (x.last ? new Date(x.last.createdAt).getTime() : 0) ||
        x.title.localeCompare(y.title, "fr"),
    );
  let active = selectedThreadId
    ? conversations.find((c) => c.kind === "thread" && same(c.thread?.id, selectedThreadId))
    : conversations.find((c) => c.kind === "direct" && same(c.contact?.id, selectedRecipient));
  active ||= conversations[0];
  if (!active) return '<article class="card empty">Aucune discussion disponible.</article>';
  if (active.kind === "thread") {
    selectedThreadId = String(active.thread.id);
    selectedRecipient = "";
  } else {
    selectedRecipient = String(active.contact.id);
    selectedThreadId = "";
  }
  const fullList = active.messages,
    messageLimit = chatMessageLimits.get(active.key) || 120,
    list = fullList.slice(-messageLimit),
    serverTotal = Number(messageStats[active.key]?.total ?? fullList.length),
    hiddenMessageCount = Math.max(0, serverTotal - list.length);
  let day = "";
  const bubbles =
    list
      .map((m) => {
        const currentDay = chatDate(m.createdAt),
          separator =
            currentDay !== day
              ? `<div class="chat-day"><span>${esc(currentDay)}</span></div>`
              : "";
        day = currentDay;
        const mine = same(m.senderId, profile.id),
          readCount = (m.readBy || []).filter(
            (id) => !same(id, m.senderId),
          ).length,
          check = mine
            ? `<span class="message-check ${readCount ? "read" : ""}" title="${readCount ? "Lu" : "Envoyé"}">${readCount ? "✓✓" : "✓"}</span>`
            : "";
        return (
          separator +
          `<div class="message ${mine ? "mine" : "theirs"} ${m.system ? "system-message" : ""} ${m.encryption ? "encrypted-message" : ""} ${m.deletedForAll ? "deleted-message" : ""}" id="msg-${esc(m.id)}" data-message-id="${esc(m.id)}">
            ${m.system ? "" : chatAvatar(mine ? profile : contacts.find((c) => same(c.id, m.senderId)) || { name: m.sender || "Participant" }, "message-avatar")}
            ${m.forwardedFromId ? '<span class="message-forwarded">↪ Transféré</span>' : ""}
            ${m.system ? '<span class="message-system-label">⚙ Sousa Group One</span>' : ""}
            ${active.kind === "thread" && !mine && !m.system ? `<b class="message-sender">${esc(m.sender || "Participant")}</b>` : ""}
            ${m.deletedForAll ? '<p class="message-deleted-text">🚫 Ce message a été supprimé pour tout le monde.</p>' : `${chatReplyHtml(m, fullList)}${chatAttachmentHtml(m)}${m.encryption ? `<p class="prewrap encrypted-text" data-encrypted-text="${esc(m.id)}">🔐 Déchiffrement…</p>` : m.text ? `<p class="prewrap">${esc(m.text)}</p>` : ""}${m.sharedRef ? `<div class="shared-ref-placeholder" data-shared-ref="${esc(m.id)}"></div>` : ""}`}
            <div class="message-meta"><time datetime="${esc(m.createdAt)}">${esc(chatTime(m.createdAt))}</time>${m.editedAt ? '<span class="message-edited">modifié</span>' : ""}${check}</div>
            <div class="message-actions">
              <button type="button" data-action="chat-reply" data-id="${esc(m.id)}">↩ Répondre</button>
              ${deleteRecordButton("messages", m)}
            </div>
          </div>`
        );
      })
      .join("") ||
    '<div class="chat-empty"><span>' + uiIcon("message") + '</span><p>Aucun message dans cette conversation.</p><small>Envoyez le premier message ci-dessous.</small></div>';

  return `<section class="whatsapp-chat ${mobileChatOpen ? "mobile-chat-open" : ""}">
    <aside class="chat-sidebar">
      <div class="chat-sidebar-head"><div><h3>Discussions</h3><span>${conversations.length} conversation${conversations.length > 1 ? "s" : ""}</span></div><details class="chat-new-menu"><summary class="chat-new-trigger" title="Nouvelle discussion">${uiIcon("plus")}<span>Nouvelle</span></summary><div class="chat-new-options"><button type="button" data-action="chat-new-group">${uiIcon("users")}Nouveau groupe</button><button type="button" data-action="chat-new-project">${uiIcon("building")}Discussion chantier</button></div></details></div>
      <label class="chat-search" for="conversationSearch">${uiIcon("search")}<input id="conversationSearch" type="search" autocomplete="off" placeholder="Rechercher une discussion" aria-label="Rechercher une discussion"></label>
      <div id="conversationList" class="chat-conversations">
        ${conversations.map((c) => {
          const preview = chatMessagePreview(c.last),
            search = `${c.title} ${c.subtitle} ${preview}`.toLowerCase(),
            isActive = c.key === active.key;
          return `<button type="button" class="chat-contact ${isActive ? "active" : ""}" data-action="chat-select" data-id="${esc(c.key)}" data-search="${esc(search)}">
            ${c.kind === "direct" ? chatAvatar(c.contact) : `<span class="chat-avatar chat-avatar-initial chat-group-avatar">${uiIcon(c.thread.type === "project" ? "building" : "users")}</span>`}
            <span class="chat-contact-body">
              <span class="chat-contact-top"><b>${esc(c.title)}</b><time>${c.last ? esc(chatTime(c.last.createdAt)) : ""}</time></span>
              <span class="chat-contact-bottom"><span class="chat-preview">${esc(preview.slice(0, 82))}</span>${c.unread ? `<strong class="chat-unread">${c.unread > 99 ? "99+" : c.unread}</strong>` : `<small>${esc(c.subtitle)}</small>`}</span>
            </span>
          </button>`;
        }).join("")}
      </div>
    </aside>
    <section class="chat-main-panel">
      <header class="chat-header">
        <button type="button" class="chat-back" data-action="chat-back" aria-label="Retour aux discussions">${uiIcon("arrow-left")}</button>
        ${active.kind === "direct" ? chatAvatar(active.contact) : `<span class="chat-avatar chat-avatar-initial chat-group-avatar">${uiIcon(active.thread.type === "project" ? "building" : "users")}</span>`}
        <div class="chat-header-person"><strong>${esc(active.title)}</strong><span>${esc(active.subtitle)}</span></div>${active.kind === "direct" ? `<div class="chat-call-actions"><button type="button" class="chat-call-button" data-action="call-start" data-id="${esc(active.contact.id)}" aria-label="Appeler ${esc(active.title)}" title="Appel audio">${uiIcon("phone")}</button><button type="button" class="chat-call-button" data-action="call-video" data-id="${esc(active.contact.id)}" aria-label="Appel vidéo ${esc(active.title)}" title="Appel vidéo">${uiIcon("video")}</button></div>` : ""}
      </header>
      <div class="chat-history">
        <div id="messageThread" class="messages chat-thread" role="log" tabindex="0" aria-live="polite" aria-label="Messages avec ${esc(active.title)}">${hiddenMessageCount ? `<button type="button" class="chat-load-older" data-action="chat-load-older" data-id="${esc(list[0]?.id || "")}">↑ Charger ${Math.min(100, hiddenMessageCount)} message(s) précédent(s)</button>` : ""}${bubbles}</div>
        <button type="button" id="chatLatest" class="chat-latest hidden" data-action="chat-latest" aria-controls="messageThread">↓ Derniers messages</button>
      </div>
      <div id="chatReplyBar" class="chat-reply-bar ${chatReplyToId ? "" : "hidden"}">
        <div><b>Réponse</b><span>${chatReplyToId ? esc((fullList.find((m) => same(m.id, chatReplyToId))?.text || "Message").slice(0, 100)) : ""}</span></div>
        <button type="button" data-action="chat-cancel-reply" aria-label="Annuler la réponse">${uiIcon("x")}</button>
      </div>
      <div id="chatAttachmentBar" class="chat-attachment-bar ${chatAttachmentDraft ? "" : "hidden"}">
        <span>${chatAttachmentDraft ? uiIcon(chatAttachmentDraft.kind === "audio" ? "mic" : "paperclip") + esc(chatAttachmentDraft.name) : ""}</span>
        <button type="button" data-action="chat-cancel-attachment" aria-label="Retirer la pièce jointe">${uiIcon("x")}</button>
      </div>
      <form id="messageForm" class="chat-composer" data-conversation="${esc(active.key)}">
        <input id="chatFile" type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/*,application/pdf,text/plain,audio/*">
        <button type="button" class="chat-tool" data-action="chat-file" aria-label="Ajouter une photo ou un fichier" title="Pièce jointe">${uiIcon("paperclip")}</button>
        ${(() => {
          // A screen refresh during a recording keeps the button in its "stop" state.
          const recording = chatRecorder?.state === "recording";
          return `<button type="button" class="chat-tool${recording ? " recording" : ""}" data-action="chat-voice" aria-label="${recording ? "Arrêter l’enregistrement" : "Enregistrer un message vocal"}" title="${recording ? "Arrêter l’enregistrement" : "Message vocal"}">${uiIcon(recording ? "stop" : "mic")}</button>`;
        })()}
        <div class="chat-compose-field"><textarea id="messageText" name="text" rows="1" maxlength="5000" placeholder="Écrire un message" aria-label="Écrire un message"></textarea><p id="formError" class="error" role="alert"></p></div>
        <button type="submit" class="chat-send" aria-label="Envoyer le message" title="Envoyer">${uiIcon("send")}</button>
      </form>
    </section>
  </section>`;
}

// Rapports: sales, costs and margin of the visible projects (single calculation, excluding VAT).
async function loadProfitReport() {
  const host = $("profitReport");
  if (!host) return;
  try {
    const out = await api("profit/summary" + (company ? "?company=" + encodeURIComponent(company) : ""));
    if (!$("profitReport")) return;
    const t = out.total;
    $("profitReport").innerHTML =
      cards([
        ["Ventes hors TVA", money(t.salesHT)],
        ["Coûts des chantiers", money(t.costs)],
        ["Marge" + (t.marginPct == null ? "" : ` (${t.marginPct} %)`), money(t.margin)],
        ["Reste à facturer", money(t.remainingToInvoiceHT)],
      ]) +
      `<p class="muted">Coûts = main-d’œuvre ${money(t.labour)} (${t.labourHours} h validées) + matériel du stock ${money(t.material)} + achats ${money(t.purchases)}, sans la TVA. <button type="button" class="link-btn" data-pro-action="profit-settings">Réglages des coûts</button></p>` +
      table(
        ["Chantier", "Ventes", "Coûts", "Marge", "Prévue"],
        out.projects.map((x) => [
          `<button type="button" class="link-btn" data-pro-action="project-central" data-id="${esc(x.id)}">${esc(x.title)}</button>`,
          money(x.salesHT),
          money(x.costs),
          `<span class="status ${x.margin < 0 ? "danger" : x.marginPct != null && x.marginPct < 10 ? "warning" : "ok"}">${money(x.margin)}${x.marginPct == null ? "" : ` · ${x.marginPct} %`}</span>`,
          x.forecastMarginPct == null ? "—" : x.forecastMarginPct + " %",
        ]),
      );
  } catch {
    host.innerHTML = "";
  }
}
function reportsView() {
  const months = new Map();
  for (const p of visible("payments")) {
    if (p.kind === "credit") continue; // a credit note is not money received
    const m = p.date.slice(0, 7);
    months.set(m, (months.get(m) || 0) + p.amount);
  }
  return (
    heading(
      "Rapports sur les données visibles",
      btn("Exporter CSV", "export", "projects"),
    ) +
    cards([
      ["Heures enregistrées", sum("time", "hours").toFixed(2) + " h"],
    ]) +
    '<div id="profitReport"></div>' +
    table(
      ["Mois", "Encaissements"],
      [...months].sort().map(([m, n]) => [esc(m), money(n)]),
    )
  );
}
const views = {
  dashboard,
  time: timeView,
  planning: planningView,
  absences: absenceView,
  projects: () =>
    heading(
      "Chantiers",
      can(ops) ? btn("Créer un chantier", "new", "projects", "primary") : "",
    ) + projectRows(visible("projects")),
  quotes: () => financeView("quotes"),
  invoices: () => financeView("invoices"),
  documents: documentsView,
  messages: messagesView,
  mailbox: () => '<div id="webmailRoot" class="wm-root"></div>',
  whatsapp: () => '<div id="whatsappRoot" class="wa-root"></div>',
  phone: () => '<div id="phoneRoot" class="ph-root"></div>',
  trade: () => '<div id="tradeRoot" class="trade-root"><p class="muted">Chargement des démarches…</p></div>',
  reports: reportsView,
  pilotage: () =>
    heading("Pilotage") +
    '<div id="operationsCenter"><article class="card"><p>Chargement du pilotage…</p></article></div>',
  pro: () =>
    heading("Centre de gestion") +
    '<div id="proStandalone"><article class="card"><p>Chargement du centre de gestion…</p></article></div>',
  advanced: () =>
    heading("Outils avancés") +
    '<div id="p2Standalone"><article class="card"><p>Chargement…</p></article></div>',
  employees: () =>
    genericPage("employees") +
    (profile.role === "admin" && profile.company === "group"
      ? heading(
          "Autres comptes",
          btn("Créer un accès", "user-form", "", "primary"),
        ) +
        '<p class="muted">Comptes sans fiche salarié active : clients, partenaires et administration.</p><div id="usersList">Chargement…</div>'
      : ""),
  users: () =>
    heading(
      "Comptes utilisateurs",
      btn("Créer un accès", "user-form", "", "primary"),
    ) + '<div id="usersList">Chargement…</div>',
  audit: () =>
    heading("Journal serveur") + '<div id="auditList">Chargement…</div>',
  settings: () =>
    heading("Mon compte") +
    '<div id="accountCenter" class="account-center-loading"><article class="card"><p>Chargement de votre compte…</p></article></div>',
};
const columns = {
  companies: [
    ["name", "Entreprise"],
    ["type", "Secteur"],
  ],
  employees: [
    ["name", "Nom"],
    ["job", "Fonction"],
    ["email", "E-mail"],
    ["company", "Entreprise"],
    ["vacation", "Vacances"],
  ],
  clients: [
    ["name", "Nom"],
    ["email", "E-mail"],
    ["phone", "Téléphone"],
    ["city", "Ville"],
  ],
  payments: [
    ["invoice", "Facture"],
    ["amount", "Montant"],
    ["date", "Date"],
    ["method", "Mode"],
  ],
  expenses: [
    ["supplier", "Fournisseur"],
    ["reference", "N° facture"],
    ["project", "Chantier"],
    ["amount", "Montant"],
    ["date", "Date"],
  ],
  inventory: [
    ["sku", "Référence"],
    ["name", "Article"],
    ["stock", "Stock"],
    ["min", "Minimum"],
    ["unit", "Unité"],
    ["buy", "Achat"],
    ["sell", "Vente"],
  ],
  suppliers: [
    ["name", "Nom"],
    ["contact", "Contact"],
    ["email", "E-mail"],
    ["phone", "Téléphone"],
  ],
  vehicles: [
    ["plate", "Plaque"],
    ["employeeId", "Attribué à"],
    ["brand", "Marque"],
    ["model", "Modèle"],
    ["km", "Kilométrage"],
    ["service", "Entretien"],
  ],
  tools: [
    ["name", "Nom"],
    ["serial", "N° série"],
    ["employeeId", "Attribué à"],
    ["status", "État"],
  ],
  maintenance: [
    ["title", "Contrat"],
    ["clientId", "Client"],
    ["frequency", "Fréquence"],
    ["next", "Prochaine visite"],
    ["amount", "Valeur annuelle"],
  ],
};
const recordDeleteRoles = {
  companies: ["admin", "direction"],
  inventory: ops,
  suppliers: ops,
  vehicles: ops,
  tools: ops,
  maintenance: ops,
  payments: fin,
  expenses: [...ops, "accounting"],
  time: [...hr, "manager", "employee"],
  absences: [...hr, "employee"],
  documents: [...ops, "hr", "accounting", "employee"],
  messages: Object.keys(roles),
};
function deleteRecordButton(kind, r) {
  if (!recordDeleteRoles[kind] || !can(recordDeleteRoles[kind])) return "";
  if (kind === "companies" && r.id === "group") return "";
  if (
    profile.role === "employee" &&
    kind === "time" &&
    r.status !== "À valider"
  )
    return "";
  if (
    profile.role === "employee" &&
    kind === "absences" &&
    r.status !== "En attente"
  )
    return "";
  return btn(
    kind === "messages" ? "Supprimer pour moi" : "Supprimer",
    "record-delete",
    kind + ":" + r.id,
    "danger",
  );
}
function personListName(person, photo = "") {
  const label = person.name || "—";
  return `<span class="person-list-name">${photo ? `<img class="person-list-photo" src="${esc(photo)}" alt="" width="40" height="40" loading="lazy">` : `<span class="person-list-photo person-list-initial" aria-hidden="true">${esc(label.slice(0, 1).toUpperCase())}</span>`}<span>${esc(label)}</span></span>`;
}
function genericPage(k) {
  const cols = columns[k] || [];
  return (
    heading(
      menus[k][0],
      (k === "payments" && can(fin)
        ? `<button type="button" class="btn primary" data-bank-action="open">Importer le relevé bancaire</button> `
        : "") +
        (k === "clients" && can([...ops, ...fin])
        ? `<button type="button" class="btn secondary" data-review-action="settings">Avis Google</button> `
        : "") +
        (createRoles[k] && can(createRoles[k])
        ? btn("Ajouter", "new", k, k === "payments" ? "secondary" : "primary") + " "
        : "") + btn("Exporter CSV", "export", k),
    ) +
    (k === "suppliers" ? '<div id="supplierCatalog"></div>' : "") +
    table(
      [
        ...cols.map((c) => c[1]),
        ...(recordDeleteRoles[k] && can(recordDeleteRoles[k])
          ? ["Actions"]
          : []),
        ...(k === "employees" ? ["Fiche et compte"] : []),
        ...(k === "clients" && can(createRoles.clients) ? ["Actions"] : []),
      ],
      visible(k).map((r) => [
        ...cols.map(([f]) =>
          k === "clients" && ["name", "email", "phone"].includes(f)
            ? clientCell(r, f)
            : ["amount", "buy", "sell", "salary"].includes(f)
            ? money(r[f])
            : ["date", "next", "service"].includes(f)
              ? date(r[f])
              : f === "employeeId"
                ? esc(r[f] ? name("employees", r[f]) : "Non attribué")
                : f === "clientId"
                  ? esc(name("clients", r[f]))
                  : f === "company"
                    ? k === "employees"
                      ? [...new Set([r.company, ...(r.companies || [])])]
                          .map((c) => esc(name("companies", c)))
                          .join(" · ")
                      : esc(name("companies", r[f]))
                    : k === "companies" && f === "name"
                      ? `<span class="company-identity"><img class="company-row-logo" src="${companyLogoPath(r.id)}" alt="" />${esc(r[f])}</span>`
                      : k === "employees" && f === "name"
                        ? personListName(r, r.photo)
                        : esc(r[f] ?? "—"),
        ),
        ...(recordDeleteRoles[k] && can(recordDeleteRoles[k])
          ? [deleteRecordButton(k, r)]
          : []),
        ...(k === "employees"
          ? [
              btn("Ouvrir la fiche", "employee-detail", r.id) +
                `<div data-employee-account="${esc(r.id)}" class="muted">${profile.role === "admin" && profile.company === "group" ? "Chargement du compte…" : ""}</div>` +
                (can(hr)
                  ? " " +
                    btn("Entreprises / accès", "employee-companies", r.id) +
                    " " +
                    btn("Supprimer", "employee-delete", r.id, "danger")
                  : ""),
            ]
          : []),
        ...(k === "clients" && can(createRoles.clients)
          ? [
              goButton(window.SGOContacts?.workAddress(r) || clientAddress(r)) +
                " " +
                (profile.role === "admin"
                ? btn("Créer un compte", "linked-user", k + ":" + r.id) + " "
                : "") +
                btn("Modifier", "client-edit", r.id) +
                " " +
                btn("Supprimer le client", "client-delete", r.id, "danger"),
            ]
          : []),
      ]),
    )
  );
}
function options(k, blank = false) {
  return (
    (blank ? '<option value="">Aucun</option>' : "") +
    (state[k] || [])
      .filter((r) => k !== "employees" || !r.deletedAt)
      .filter((r) => k !== "companies" || r.id !== "group")
      .map(
        (r) =>
          `<option value="${esc(r.id)}">${esc(r.name || r.title || r.id)}</option>`,
      )
      .join("")
  );
}
// Field definitions shared by the creation dialogs; server validation remains authoritative.
const employeeContactFields = [
  ["street", "Adresse / rue et numéro", "text?"],
  ["zip", "Code postal", "text?"],
  ["city", "Ville", "text?"],
  ["country", "Pays", "text?"],
  ["birthDate", "Date de naissance", "date?"],
  ["nationality", "Nationalité(s)", "text?"],
  [
    "residencePermit",
    "Permis de séjour (B, C, L, G, etc. ou non applicable)",
    "text?",
  ],
  ["residencePermitExpiry", "Expiration du permis de séjour", "date?"],
  ["emergencyName", "Contact d’urgence", "text?"],
  ["emergencyPhone", "Téléphone d’urgence", "tel?"],
  ["contractType", "Type de contrat", "text?"],
  ["endDate", "Fin du contrat", "date?"],
  ["notes", "Notes RH", "textarea?"],
];
const schemas = {
  companies: [
    ["name", "Nom"],
    ["code", "Code"],
    ["type", "Secteur"],
  ],
  employees: [
    ["name", "Nom"],
    ["job", "Fonction"],
    ["company", "Entreprise", "@companies"],
    ["email", "E-mail", "email"],
    ["phone", "Téléphone", "tel?"],
    ["salaryPeriod", "Type de salaire", "salary-period"],
    ["salary", "Salaire mensuel (CHF/mois)", "number"],
    ["activity", "Taux d’activité %", "number", "100"],
    ["weeklyHours", "Heures hebdomadaires contractuelles", "number", "42"],
    ["vacation", "Solde de vacances (jours)", "number", "20"],
    ["entry", "Date d’entrée", "date"],
    ...employeeContactFields,
  ],
  clients: [
    ["name", "Nom"],
    ["company", "Entreprise", "@companies"],
    ["street", "Rue", "text?"],
    ["buildingNumber", "Numéro", "text?"],
    ["zip", "Code postal", "text?"],
    ["city", "Ville"],
    ["country", "Pays (code ISO)", "text", "CH"],
    ["type", "Type", "text?"],
  ],
  projects: [
    ["title", "Titre"],
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["address", "Adresse"],
    ["start", "Début", "date"],
    ["end", "Fin", "date"],
    ["budget", "Budget CHF", "number"],
    ["plannedHours", "Heures prévues", "number?"],
    ["plannedMaterial", "Matériel prévu CHF hors TVA", "number?"],
    ["description", "Description", "textarea?"],
  ],
  planning: [
    ["employeeId", "Salarié", "@employees"],
    ["project", "Chantier", "@projects"],
    ["date", "Date", "date"],
    ["start", "Début", "time"],
    ["end", "Fin", "time"],
    ["location", "Lieu", "text?"],
  ],
  quotes: [
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["project", "Chantier", "@projects?"],
    ["title", "Objet"],
    ["date", "Date", "date"],
    ["valid", "Valable jusqu’au", "date"],
  ],
  invoices: [
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["project", "Chantier", "@projects?"],
    ["title", "Objet"],
    ["date", "Date", "date"],
    ["due", "Échéance", "date"],
  ],
  payments: [
    ["invoice", "Facture", "@invoices"],
    ["amount", "Montant CHF", "number"],
    ["date", "Date", "date"],
    ["method", "Mode", "text", "Virement"],
  ],
  expenses: [
    ["company", "Entreprise", "@companies"],
    ["supplier", "Fournisseur"],
    ["reference", "N° de facture", "text?"],
    ["project", "Chantier", "@projects?"],
    ["amount", "Montant CHF (TVA comprise)", "number"],
    ["date", "Date", "date"],
  ],
  inventory: [
    ["company", "Entreprise", "@companies"],
    ["sku", "Référence"],
    ["name", "Nom"],
    ["category", "Catégorie", "text?"],
    ["stock", "Stock", "number", "0"],
    ["min", "Minimum", "number", "0"],
    ["unit", "Unité", "text", "pcs"],
    ["buy", "Achat CHF", "number", "0"],
    ["sell", "Vente CHF", "number", "0"],
  ],
  suppliers: [
    ["company", "Entreprise", "@companies"],
    ["name", "Nom"],
    ["contact", "Contact", "text?"],
    ["email", "E-mail", "email"],
    ["phone", "Téléphone", "tel?"],
  ],
  vehicles: [
    ["company", "Entreprise", "@companies"],
    ["plate", "Plaque"],
    ["brand", "Marque"],
    ["model", "Modèle"],
    ["km", "Kilométrage", "number", "0"],
    ["service", "Prochain entretien", "date?"],
  ],
  tools: [
    ["company", "Entreprise", "@companies"],
    ["name", "Nom"],
    ["serial", "Numéro de série"],
  ],
  maintenance: [
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["title", "Titre"],
    ["frequency", "Fréquence", "text", "Mensuelle"],
    ["next", "Prochaine visite", "date"],
    ["amount", "Valeur annuelle CHF", "number"],
  ],
};
function field([key, label, type = "text", value = ""]) {
  const optional = type.endsWith("?");
  type = type.replace("?", "");
  const required = optional ? "" : "required",
    attr = `id="f_${key}" name="${key}" ${required}`;
  return (
    `<label for="f_${key}">${esc(label)}${optional ? " (facultatif)" : ""}</label>` +
    (type === "salary-period"
      ? `<select ${attr}><option value="monthly">Salaire mensuel</option><option value="hourly">Salaire horaire</option></select>`
      : type.startsWith("@")
        ? `<select ${attr}>${options(type.slice(1), optional)}</select>`
        : type === "textarea"
          ? `<textarea ${attr} maxlength="5000">${esc(value)}</textarea>`
          : `<input ${attr} type="${type}" value="${esc(value || (type === "date" && !optional ? today() : ""))}" ${type === "number" ? 'min="0" step="0.01"' : ""} ${type === "password" ? (key === "currentPassword" ? 'autocomplete="current-password"' : 'minlength="12" autocomplete="new-password"') : ""}>`)
  );
}
function modal(title, html) {
  lastFocus = document.activeElement;
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modalWrap").classList.remove("hidden");
  $("modalBody").querySelector("input,select,button")?.focus();
}
function closeModal(force = false) {
  if (pending && !force) return;
  $("modalWrap").classList.add("hidden");
  $("modalBody").replaceChildren();
  lastFocus?.focus();
}
function formShell(fields, kind, extra = "", title = "Ajouter") {
  modal(
    title,
    `<form id="entityForm" method="post" data-kind="${esc(kind)}">${fields.map(field).join("")}${extra}<p id="formError" role="alert" class="error"></p><div class="form-actions">${btn("Annuler", "close-modal")}<button type="submit" class="btn primary">Enregistrer</button></div></form>`,
  );
}
function lineRow(l = {}) {
  return `<div class="invoice-line"><label>Description<input name="lineDescription" required maxlength="500" value="${esc(l.description || "")}"></label><label class="line-details">Détails de la prestation<textarea name="lineDetails" maxlength="5000" rows="3">${esc(l.details || "")}</textarea></label><label>Quantité<input name="lineQuantity" type="number" step="0.001" min="0.001" value="${esc(l.quantity ?? 1)}" required></label><label>Unité<input name="lineUnit" maxlength="30" value="${esc(l.unit || "pcs")}"></label><label>Prix HT CHF<input name="linePrice" type="number" step="0.01" min="0" value="${esc(l.unitPrice ?? "")}" required></label><label>Remise %<input name="lineDiscount" type="number" step="0.01" min="0" max="100" value="${esc(l.discount ?? 0)}" required></label><label>TVA %<input name="lineVat" type="number" step="0.01" min="0" max="100" list="vatRates" value="${esc(l.vatRate ?? 0)}" required></label>${btn("Retirer", "remove-line")}</div>`;
}
function financeLines(f = $("entityForm")) {
  return [...f.querySelectorAll(".invoice-line")].map((row) =>
    Object.fromEntries(
      [
        ["description", "lineDescription"],
        ["details", "lineDetails"],
        ["quantity", "lineQuantity"],
        ["unit", "lineUnit"],
        ["unitPrice", "linePrice"],
        ["discount", "lineDiscount"],
        ["vatRate", "lineVat"],
      ].map(([key, name]) => [key, row.querySelector(`[name=${name}]`).value]),
    ),
  );
}
function financeTotals() {
  if (!$("financeTotals")) return;
  try {
    const t = SousaFinance.calculate(financeLines());
    $("financeTotals").textContent =
      `Brut HT ${money(t.subtotal)} · Remise ${money(t.discountAmount)} · Net HT ${money(t.net)} · TVA ${money(t.tax)} · Total TTC ${money(t.amount)}`;
    const deposit = SousaFinance.paymentSummary({
      ...t,
      depositPercent: $("entityForm").elements.depositPercent?.value || 0,
    });
    if (deposit.depositPercent)
      $("financeTotals").textContent +=
        ` · Acompte ${deposit.depositPercent} % : ${money(deposit.depositAmount)}`;
  } catch (e) {
    $("financeTotals").textContent = e.message;
  }
}
function afterDays(dateValue, days = 30) {
  const d = new Date(dateValue + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
function financeForm(k, r, initial) {
  const co =
    r?.company ||
    initial?.company ||
    company ||
    visible("clients")[0]?.company ||
    visible("companies").find((c) => c.id !== "group")?.id;
  const settings = find("companies", co)?.billing || {};
  const value = r ||
    initial || {
      company: co,
      date: today(),
      valid: afterDays(today()),
      due: afterDays(today(), settings.paymentDays ?? 30),
      message: settings.defaultMessage,
      terms: settings.defaultTerms,
      language: "fr",
    };
  formShell(
    schemas[k],
    r ? "finance.update" : k,
    `<label for="f_site">Lieu d’intervention (si ce n’est pas l’adresse de facturation)</label><input id="f_site" name="site" maxlength="300" placeholder="Ex. Elfenstrasse 3, 3006 Berne"><p class="muted">1. Client et dates · 2. Prestations · 3. Vérification puis émission</p><p>${btn("Créer un client", "finance-client", k)}</p><h4>Prestations</h4><p class="muted">Prix hors taxe. Choisissez le taux applicable à chaque prestation ; 0 % par défaut.</p><datalist id="vatRates"><option value="0"><option value="2.6"><option value="3.8"><option value="8.1"></datalist><div id="lines">${(value.lines || [{}]).map(lineRow).join("")}</div>${btn("Ajouter une ligne", "add-line")}<div id="financeTotals" class="finance-totals" role="status" aria-live="polite"></div><label>Langue du document<select name="language">${[
      ["fr", "Français"],
      ["de", "Deutsch"],
      ["it", "Italiano"],
      ["en", "English"],
    ]
      .map(([v, t]) => `<option value="${v}">${t}</option>`)
      .join(
        "",
      )}</select></label>${field(["message", "Introduction / message au client", "textarea?"])}${field(["scope", "Objet détaillé des travaux", "textarea?"])}${field(["exclusions", "Non compris / options", "textarea?"])}${field(["terms", "Conditions", "textarea?"])}<label>Acompte demandé (%)<input name="depositPercent" type="number" min="0" max="100" step="0.01" value="0" required></label><p class="muted">0 = sans acompte. Le QR demandera l’acompte restant, puis le solde une fois l’acompte encaissé.</p>${field(["paymentNote", "Consigne de paiement", "textarea?"])}${field(["paymentReference", "Référence bancaire structurée (facultatif)", "text?"])}${k === "quotes" ? '<label>Zone de signature<select name="signature"><option value="true">Oui</option><option value="false">Non</option></select></label>' : ""}${r ? `<input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="kind" value="${k}">` : ""}`,
    r
      ? "Modifier le brouillon"
      : k === "quotes"
        ? "Nouveau devis"
        : "Nouvelle facture",
  );
  for (const [key, v] of Object.entries(value)) {
    const input = $("entityForm").elements.namedItem(key);
    if (input && v != null && !["lines", "kind", "id"].includes(key))
      input.value = String(v);
  }
  filterFinanceClient();
  fillWorkAddress($("f_site"), find("clients", $("f_clientId")?.value));
  financeTotals();
  const previous = [...state.quotes, ...state.invoices]
    .filter((x) => x.company === co)
    .flatMap((x) => x.lines || []);
  const unique = [
    ...new Map(previous.map((l) => [l.description, l])).values(),
  ].slice(0, 100);
  if (unique.length) {
    $("lines").insertAdjacentHTML(
      "beforebegin",
      `<label>Réutiliser une prestation<select id="reuseLine"><option value="">Choisir dans les documents précédents…</option>${unique.map((l, i) => `<option value="${i}">${esc(l.description)}</option>`).join("")}</select></label>`,
    );
    $("reuseLine").addEventListener("change", (e) => {
      if (e.target.value !== "") {
        $("lines").insertAdjacentHTML(
          "beforeend",
          lineRow(unique[Number(e.target.value)]),
        );
        financeTotals();
        e.target.value = "";
      }
    });
  }
}
function filterFinanceClient() {
  if (!$("lines")) return;
  const co = $("f_company").value;
  for (const option of $("f_clientId").options)
    option.disabled = find("clients", option.value)?.company !== co;
  if ($("f_clientId").selectedOptions[0]?.disabled)
    $("f_clientId").value =
      [...$("f_clientId").options].find((o) => !o.disabled)?.value || "";
  const clientId = $("f_clientId").value;
  for (const option of $("f_project").options) {
    const project = find("projects", option.value);
    option.disabled =
      !!option.value &&
      (project?.company !== co || !same(project?.clientId, clientId));
  }
  if ($("f_project").selectedOptions[0]?.disabled) $("f_project").value = "";
}
function billingSettings() {
  formShell(
    [
      ["company", "Entreprise", "@companies"],
      ...[
        "street",
        "buildingNumber",
        "zip",
        "city",
        "country",
        "vatNumber",
        "iban",
        "email",
      ].map((k, i) => [
        k,
        [
          "Rue",
          "Numéro",
          "Code postal",
          "Ville",
          "Pays (CH/LI)",
          "Numéro TVA",
          "IBAN",
          "E-mail",
        ][i],
        "text?",
      ]),
      ["paymentDays", "Délai de paiement (jours)", "number", "30"],
      ["defaultMessage", "Message par défaut", "textarea?"],
      ["defaultTerms", "Conditions par défaut", "textarea?"],
    ],
    "finance.settings",
    '<p class="muted">Ces coordonnées seront conservées sur les documents lors de leur émission.</p>',
    "Paramètres de facturation",
  );
  if (company) $("f_company").value = company;
  loadBillingSettings();
}
function loadBillingSettings() {
  const s = find("companies", $("f_company").value)?.billing || {};
  for (const input of $("entityForm").elements)
    if (input.name && input.name !== "company")
      input.value =
        s[input.name] ??
        (input.name === "country"
          ? "CH"
          : input.name === "paymentDays"
            ? 30
            : "");
}
function newForm(k) {
  if (!schemas[k]) return;
  if (["quotes", "invoices"].includes(k)) return financeForm(k);
  formShell(
    schemas[k],
    k,
    ["quotes", "invoices"].includes(k)
      ? `<h4 class="spaced">Lignes du document</h4><div id="lines">${lineRow()}</div>${btn("Ajouter une ligne", "add-line")}`
      : k === "clients"
        ? contactsEditor({}) + field(["notes", "Remarques (accès, consignes, interlocuteurs…)", "textarea?"])
        : k === "expenses"
          ? `<label for="f_vatRate">TVA comprise dans le montant</label><select id="f_vatRate" name="vatRate"><option value="8.1" selected>8,1 % (taux normal)</option><option value="2.6">2,6 % (taux réduit)</option><option value="3.8">3,8 % (hébergement)</option><option value="0">Sans TVA</option></select><p class="muted">La TVA des achats est récupérée : seul le montant hors TVA compte dans le coût du chantier.</p>`
          : "",
    k === "clients" ? "Nouveau client" : menus[k][0],
  );
  if (k === "clients") arrangeClientForm({});
  if (k === "projects") fillWorkAddress($("f_address"), find("clients", $("f_clientId")?.value), true);
  if (company && $("f_company")) $("f_company").value = company;
}
// Several e-mails and phone numbers per client, each with a label; the first is the main one.
// In the list of clients: the name opens the card; the main e-mail / number, and how many more.
function clientCell(r, f) {
  if (f === "name") return `<button type="button" class="link-btn client-name" data-action="client-card" data-id="${esc(r.id)}">${esc(r.name)}</button>`;
  const C = window.SGOContacts;
  const list = C ? (f === "email" ? C.emails(r).map((e) => e.address) : C.phones(r).map((p) => p.number)) : [r[f]].filter(Boolean);
  if (!list.length) return "—";
  return esc(list[0]) + (list.length > 1 ? ` <span class="more-count" title="${esc(list.slice(1).join(", "))}">+${list.length - 1}</span>` : "");
}
function contactRow(kind, item = {}, index = 0) {
  const email = kind === "emails";
  const value = email ? item.address : item.number;
  return `<div class="contact-row${index === 0 ? " is-main" : ""}" data-contact-row="${kind}"><input class="contact-value" type="${email ? "email" : "tel"}" value="${esc(value || "")}" placeholder="${email ? "adresse@exemple.ch" : "+41 79 123 45 67"}" aria-label="${email ? "Adresse e-mail" : "Numéro de téléphone"}" ${email && index === 0 ? "required" : ""} maxlength="${email ? 254 : 40}"><input class="contact-label" value="${esc(item.label || "")}" placeholder="${email ? "Libellé (ex. Secrétariat)" : "Libellé (ex. Mobile, Bureau)"}" aria-label="Libellé" maxlength="60"><span class="contact-tools">${index === 0 ? '<span class="contact-main">Principal</span>' : `<button type="button" class="link-btn" data-action="contact-main">Principal</button>`}<button type="button" class="contact-remove" data-action="contact-remove" aria-label="Retirer" title="Retirer">×</button></span></div>`;
}
function contactsEditor(c) {
  const C = window.SGOContacts;
  const emails = C ? C.emails(c) : c.email ? [{ address: c.email }] : [];
  const phones = C ? C.phones(c) : c.phone ? [{ number: c.phone }] : [];
  return `<fieldset class="contact-list" data-contact-kind="emails"><legend>E-mails</legend><p class="muted">Le principal reçoit les factures, les devis et les e-mails automatiques ; les autres sont reconnus quand ils vous écrivent.</p><div class="contact-rows">${(emails.length ? emails : [{}]).map((e, i) => contactRow("emails", e, i)).join("")}</div><button type="button" class="btn secondary" data-action="contact-add" data-id="emails">+ Ajouter un e-mail</button></fieldset><fieldset class="contact-list" data-contact-kind="phones"><legend>Téléphones</legend><p class="muted">Tous les numéros sont reconnus pour les appels, les SMS et WhatsApp.</p><div class="contact-rows">${phones.map((p, i) => contactRow("phones", p, i)).join("")}</div><button type="button" class="btn secondary" data-action="contact-add" data-id="phones">+ Ajouter un numéro</button></fieldset>`;
}
// The client form: e-mails and numbers, then the billing address (grouped), then the work sites.
function arrangeClientForm(client) {
  placeContacts();
  const street = $("f_street");
  if (!street) return;
  const box = document.createElement("fieldset");
  box.className = "address-block";
  box.innerHTML = '<legend>Adresse de facturation</legend><p class="muted">Imprimée sur les devis, les factures et le bulletin QR.</p>';
  (street.labels?.[0] || street).before(box);
  for (const key of ["street", "buildingNumber", "zip", "city", "country"]) {
    const input = $("f_" + key);
    if (input) box.append(...(input.labels?.[0] ? [input.labels[0]] : []), input);
  }
  box.insertAdjacentHTML("afterend", sitesEditor(client));
}
function siteRow(x = {}) {
  return `<div class="site-row" data-site-row><input class="site-label" value="${esc(x.label || "")}" placeholder="Nom du lieu (ex. Résidence)" maxlength="60" aria-label="Nom du lieu"><input class="site-street" value="${esc(x.street || "")}" placeholder="Rue et numéro" maxlength="200" aria-label="Rue et numéro"><input class="site-zip" value="${esc(x.zip || "")}" placeholder="NPA" maxlength="20" inputmode="numeric" aria-label="NPA"><input class="site-city" value="${esc(x.city || "")}" placeholder="Localité" maxlength="100" aria-label="Localité"><button type="button" class="contact-remove" data-action="site-remove" aria-label="Retirer cette adresse" title="Retirer">×</button></div>`;
}
function sitesEditor(c) {
  const list = window.SGOContacts ? window.SGOContacts.sites(c) : [];
  return `<fieldset class="site-list"><legend>Adresses d’intervention</legend><p class="muted">Où vous travaillez, si ce n’est pas à l’adresse de facturation (résidence, dépôt, autre bâtiment…). Proposées pour les chantiers, les devis, les factures et « Y aller ».</p><div class="site-rows">${list.map(siteRow).join("")}</div><button type="button" class="btn secondary" data-action="site-add">+ Ajouter une adresse d’intervention</button></fieldset>`;
}
// The addresses offered for a client (work sites first, then billing), in a list under the field.
function addressChoices(c) {
  const C = window.SGOContacts;
  if (!c || !C) return [];
  return [...C.sites(c).map((x) => ({ label: x.label || "Intervention", text: C.siteText(x) })), { label: "Facturation", text: C.billingText(c) }].filter((x) => x.text);
}
function fillWorkAddress(input, c, always = false) {
  if (!input) return;
  const id = input.id + "Choices";
  let list = $(id);
  if (!list) {
    list = document.createElement("datalist");
    list.id = id;
    input.after(list);
    input.setAttribute("list", id);
  }
  const choices = addressChoices(c);
  list.innerHTML = choices.map((x) => `<option value="${esc(x.text)}">${esc(x.label)}</option>`).join("");
  // Filled automatically only while the person has not typed in it.
  if (!input.value || input.dataset.auto) {
    const C = window.SGOContacts;
    const value = !c || !C ? "" : always ? C.workAddress(c) : C.sites(c)[0] ? C.siteText(C.sites(c)[0]) : "";
    input.value = value;
    if (value) input.dataset.auto = "1";
    else delete input.dataset.auto;
  }
}
// E-mails and numbers right after the name (and company), before the address.
function placeContacts() {
  const before = $("f_street")?.labels?.[0] || $("f_street");
  if (before) for (const list of document.querySelectorAll("#entityForm .contact-list")) before.before(list);
}
function renumberContacts(list) {
  const rows = [...list.querySelectorAll(".contact-row")];
  const kind = list.dataset.contactKind;
  rows.forEach((row, i) => {
    row.classList.toggle("is-main", i === 0);
    const tools = row.querySelector(".contact-tools");
    tools.firstElementChild.outerHTML = i === 0 ? '<span class="contact-main">Principal</span>' : '<button type="button" class="link-btn" data-action="contact-main">Principal</button>';
    if (kind === "emails") row.querySelector(".contact-value").required = i === 0;
  });
}
function readContacts(form) {
  const out = {};
  for (const list of form.querySelectorAll(".contact-list")) {
    const kind = list.dataset.contactKind;
    out[kind] = [...list.querySelectorAll(".contact-row")]
      .map((row) => ({ label: row.querySelector(".contact-label").value.trim(), [kind === "emails" ? "address" : "number"]: row.querySelector(".contact-value").value.trim() }))
      .filter((x) => x.address || x.number);
  }
  if (form.querySelector(".site-list"))
    out.sites = [...form.querySelectorAll("[data-site-row]")]
      .map((row) => ({ label: row.querySelector(".site-label").value.trim(), street: row.querySelector(".site-street").value.trim(), zip: row.querySelector(".site-zip").value.trim(), city: row.querySelector(".site-city").value.trim() }))
      .filter((x) => x.street || x.city || x.zip);
  return out;
}
function clientCard(id) {
  const c = find("clients", id);
  if (!c) return;
  const C = window.SGOContacts;
  const emails = C ? C.emails(c) : [{ address: c.email }];
  const phones = C ? C.phones(c) : c.phone ? [{ number: c.phone }] : [];
  const tel = (n) => String(n).replace(/[^\d+]/g, "");
  const projects = visible("projects").filter((p) => same(p.clientId, id));
  const open = visible("invoices").filter((i) => same(i.clientId, id) && !["Payée", "Annulée", "Brouillon"].includes(i.status));
  modal(
    c.name,
    `<div class="client-card"><section><h4>E-mails</h4><ul class="client-contacts">${emails
      .map((e, i) => `<li><a href="mailto:${esc(encodeURIComponent(e.address).replace(/%40/g, "@"))}">${esc(e.address)}</a>${e.label ? ` <span class="muted">· ${esc(e.label)}</span>` : ""}${i === 0 ? ' <span class="contact-main">Principal</span>' : ""}</li>`)
      .join("")}</ul></section><section><h4>Téléphones</h4>${phones.length ? `<ul class="client-contacts">${phones.map((p) => `<li><a href="tel:${esc(tel(p.number))}">${esc(p.number)}</a>${p.label ? ` <span class="muted">· ${esc(p.label)}</span>` : ""}</li>`).join("")}</ul>` : '<p class="muted">Aucun numéro.</p>'}</section><section><h4>Adresse de facturation</h4><p class="go-line"><span>${esc(clientAddress(c) || "—")}</span> ${goButton(clientAddress(c))}</p></section><section><h4>Adresses d’intervention</h4>${
      C && C.sites(c).length
        ? `<ul class="client-contacts">${C.sites(c)
            .map((x) => `<li class="go-line"><span>${x.label ? `<b>${esc(x.label)}</b> · ` : ""}${esc(C.siteText(x))}</span> ${goButton(C.siteText(x))}</li>`)
            .join("")}</ul>`
        : '<p class="muted">Identique à l’adresse de facturation.</p>'
    }</section>${c.notes ? `<section><h4>Remarques</h4><p class="preserve-lines">${esc(c.notes)}</p></section>` : ""}<section><h4>Suivi</h4><p>${projects.length} chantier${projects.length > 1 ? "s" : ""} · ${open.length} facture${open.length > 1 ? "s" : ""} ouverte${open.length > 1 ? "s" : ""}${open.length ? " (" + money(open.reduce((t, i) => t + (Number(i.amount) || 0) - (Number(i.paid) || 0), 0)) + ")" : ""}</p></section>${can(createRoles.clients) ? `<div class="form-actions">${btn("Modifier la fiche", "client-edit", id, "primary")}</div>` : ""}</div>`,
  );
}
function clientEdit(id) {
  const client = find("clients", id);
  if (!client) return;
  const fields = schemas.clients.filter(([key]) => key !== "company");
  formShell(
    fields,
    "client.update",
    `<input type="hidden" name="id" value="${esc(id)}">${contactsEditor(client)}${field(["notes", "Remarques (accès, consignes, interlocuteurs…)", "textarea?", client.notes || ""])}<p class="muted">Les e-mails de la fiche ne changent pas l’identifiant du compte de connexion du client. Les documents déjà émis gardent leurs coordonnées d’origine.</p>`,
    "Modifier le client",
  );
  arrangeClientForm(client);
  for (const [key] of fields)
    $("f_" + key).value = client[key] ?? (key === "country" ? "CH" : "");
}
function projectModal(id) {
  const p = find("projects", id);
  if (!p) return;
  modal(
    p.title,
    `<button type="button" class="btn primary" data-pro-action="project-central" data-id="${esc(id)}">Fiche chantier centrale</button> ` +
    (can([...ops, ...fin])
      ? btn("Chantier terminé → Facturation", "project-finish", id, "primary")
      : "") +
      (p.invoiceIds || [])
        .filter((i) => find("invoices", i))
        .map((i) => btn("Ouvrir la facture " + i, "invoice", i))
        .join(" ") +
      `${p.description ? `<p>${esc(p.description)}</p>` : ""}${p.address ? `<p class="go-line"><span>${esc(p.address)}</span> ${goButton(p.address)}</p>` : ""}<p class="project-summary">${[p.clientId ? esc(name("clients", p.clientId)) : "", p.status ? badge(p.status) : "", p.start && p.end ? `${date(p.start)} – ${date(p.end)}` : p.start ? "Début " + date(p.start) : p.end ? "Fin " + date(p.end) : "", "Avancement " + esc(p.progress ?? 0) + " %"].filter(Boolean).join(" · ")}</p><p>Équipe : ${(p.team || []).map((id) => esc(name("employees", id))).join(", ") || "Non affectée"}</p><p class="profit-summary" data-profit-summary="${esc(id)}" hidden></p>${can(ops) ? btn("Modifier le suivi", "project-edit", id) + " " + btn("Supprimer le chantier", "project-delete", id, "danger") : ""} ${(() => { const thread = (state.messageThreads || []).find((t) => same(t.projectId, id)); return thread ? btn("Ouvrir la discussion", "chat-open-project", thread.id, "primary") : can(ops) ? btn("Créer la discussion chantier", "chat-create-project", id) : ""; })()}<h4 class="spaced">Documents et photos</h4>${table(
        ["Fichier", ""],
        state.documents
          .filter((x) => same(x.project, id))
          .map((d) => [
            esc(d.name),
            btn("Télécharger", "download", d.id) +
              " " +
              deleteRecordButton("documents", d),
          ]),
      )}<div data-trade-project="${esc(id)}"></div>`,
  );
  window.SGOTrade?.projectModal?.(p);
  loadProfitSummary(id);
}
// The project's margin (for those who may see margins), from the single calculation.
async function loadProfitSummary(id) {
  const host = document.querySelector(`[data-profit-summary="${CSS.escape(String(id))}"]`);
  if (!host) return;
  try {
    const { profit: f } = await api("profit/project/" + encodeURIComponent(id));
    const tone = f.margin < 0 ? "danger" : f.marginPct != null && f.marginPct < 10 ? "warning" : "ok";
    host.innerHTML = `Ventes ${money(f.sales.salesHT)} · Coûts ${money(f.costs.total)} · <span class="status ${tone}">Marge ${money(f.margin)}${f.marginPct == null ? "" : ` (${f.marginPct} %)`}</span> <span class="muted">hors TVA</span>${f.forecast ? ` · prévue ${f.forecast.marginPct == null ? money(f.forecast.margin) : f.forecast.marginPct + " %"}` : ""} <button type="button" class="link-btn" data-pro-action="project-central" data-id="${esc(id)}">Détail</button>`;
    host.hidden = false;
  } catch {
    host.remove();
  }
}
function documentModal(k, id) {
  const r = find(k, id);
  if (!r) return;
  const payment = SousaFinance.paymentSummary(r);
  const c = r.customer || find("clients", r.clientId),
    co = r.issuer || find("companies", r.company);
  const address = (a) =>
    esc(
      [a?.street, a?.buildingNumber, a?.zip, a?.city, a?.country]
        .filter(Boolean)
        .join(" "),
    );
  const html = `<div class="document"><div class="document-head"><div><h2>${esc(co?.name || "Sousa Group")}</h2><p>${address(co?.billing)}</p><p>${esc(co?.billing?.vatNumber)}</p></div><div><b>${k === "quotes" ? "DEVIS" : "FACTURE"}</b><p>${esc(r.id)}</p><p>${date(r.date)}</p>${r.status === "Brouillon" ? "<b>BROUILLON — NON ÉMIS</b>" : ""}</div></div><p>Client : ${esc(c?.name)}<br>${address(c)}<br>${esc(c?.email)}</p><h3>${esc(r.title)}</h3>${table(
    ["Description", "Quantité", "Prix HT", "Remise", "TVA", "Total TTC"],
    (
      r.lines || [{ description: r.title, quantity: 1, unitPrice: r.amount }]
    ).map((l) => [
      `<b>${esc(l.description)}</b><p class="preserve-lines">${esc(l.details)}</p>`,
      esc(l.quantity) + " " + esc(l.unit),
      money(l.unitPrice),
      esc(l.discount || 0) + " %",
      esc(l.vatRate || 0) + " %",
      money(
        l.total ?? Math.round(l.quantity * Math.round(l.unitPrice * 100)) / 100,
      ),
    ]),
  )}${r.net !== undefined ? `<p>Remise : ${money(r.discountAmount)} · Net HT : ${money(r.net)}</p>${(r.taxGroups || []).map((g) => `<p>TVA ${esc(g.rate)} % sur ${money(g.base)} : ${money(g.tax)}</p>`).join("")}` : ""}<div class="doc-total"><b>Total TTC : ${money(r.amount)}</b></div><p>${k === "quotes" ? "Valable jusqu’au" : "Échéance"} : ${date(r.valid || r.due)}</p>${k === "invoices" ? `<p>Payé : ${money(r.paid)} · Solde : ${money(r.amount - (r.paid || 0))}</p>` : ""}<p>IBAN : ${esc(co?.billing?.iban || "Non renseigné")}</p><p class="preserve-lines">${esc(r.message)}</p><p class="preserve-lines">${esc(r.terms)}</p>${r.acceptedAt ? `<p>Acceptation enregistrée le ${esc(new Date(r.acceptedAt).toLocaleString("fr-CH"))}.</p>` : ""}${k === "quotes" && r.signature !== false ? '<p class="spaced">Date et signature : ______________________________</p>' : ""}${r.invoiceId ? `<p>Facture liée : ${esc(r.invoiceId)}</p>` : ""}${r.quoteId ? `<p>Devis d’origine : ${esc(r.quoteId)}</p>` : ""}</div>`;
  const brandedHtml = html.replace(
    '<div class="document-head">',
    `<img class="document-logo" src="${companyLogoPath(r.company, co)}" alt="${esc(co?.name || "Sousa Group")}" /><div class="document-head">`,
  );
  $("printArea").innerHTML = brandedHtml;
  const appendix = `<div class="document"><p class="preserve-lines">${esc(r.scope)}</p>${r.exclusions ? `<h4>Non compris / options</h4><p class="preserve-lines">${esc(r.exclusions)}</p>` : ""}<p class="preserve-lines">${esc(r.paymentNote)}</p>${payment.depositPercent ? `<p>Acompte : ${payment.depositPercent} % · Montant : ${money(payment.depositAmount)}</p><p>Acompte restant : ${money(payment.depositRemaining)} · Solde total : ${money(payment.balance)}</p>` : ""}</div>`;
  modal(
    r.id,
    btn("Imprimer / PDF", "finance-pdf", k + ":" + id) +
      " " +
      (can(fin) && r.status === "Brouillon"
        ? btn(
            "Émettre",
            k === "quotes" ? "quote.issue" : "invoice.issue",
            id,
            "primary",
          )
        : "") +
      " " +
      (profile.role === "client" && k === "quotes" && r.status === "Émise"
        ? btn("Accepter le devis", "quote.accept", id, "primary")
        : "") +
      (can(fin)
        ? `<div class="actions spaced">${r.status === "Brouillon" ? btn("Modifier", "finance-edit", k + ":" + id) : ""} ${btn("Dupliquer", "finance-copy", k + ":" + id)} ${k === "quotes" && r.status === "Émise" ? btn("Enregistrer la réponse", "quote-decision", id) : ""} ${k === "quotes" && r.status === "Accepté" && !r.invoiceId ? btn("Convertir en facture", "quote-convert", id, "primary") : ""} ${k === "invoices" && r.status !== "Brouillon" && r.status !== "Payée" ? btn("Enregistrer un paiement", "invoice-payment", id) : ""}</div>`
        : "") +
      ` <p>${btn("Télécharger PDF", "finance-pdf", k + ":" + id)} ${k === "invoices" && r.status !== "Brouillon" && r.status !== "Payée" ? btn("PDF avec QR de paiement", "finance-qr", k + ":" + id) : ""} ${can(fin) && r.status !== "Brouillon" ? btn("Préparer e-mail avec PDF (.eml)", "finance-email", k + ":" + id) : ""}</p>` +
      (r.status === "Brouillon"
        ? '<p class="notice">Brouillon — non émis</p>'
        : "") +
      brandedHtml +
      appendix +
      (r.project && find("projects", r.project)
        ? btn("Ouvrir le chantier", "project", r.project)
        : "") +
      (r.workSummary
        ? `<h4>Récapitulatif du chantier</h4><p class="preserve-lines">${esc(r.workSummary)}</p>`
        : "") +
      (can(fin) && r.completionSnapshot
        ? `<h4>Données internes du chantier</h4><p>${r.completionSnapshot.time.length} saisie(s) d’heures · ${r.completionSnapshot.expenses.length} dépense(s) · ${r.completionSnapshot.documents.length} document(s)</p>${table(
            ["Dépense", "Montant"],
            r.completionSnapshot.expenses.map((e) => [
              esc(e.supplier),
              money(e.amount),
            ]),
          )}<p>Les pièces originales et le suivi restent consultables depuis le chantier. Les heures et dépenses ne sont pas ajoutées automatiquement au prix du devis.</p>`
        : "") +
      (can(fin)
        ? `<div class="actions spaced">${k === "quotes" && r.status === "Accepté" ? btn(r.project ? "Ouvrir le chantier" : "Créer le chantier", "quote-project", id, "primary") : ""} ${r.status === "Brouillon" ? btn("Supprimer le brouillon", "finance-delete", k + ":" + id, "danger") : btn(r.archivedAt ? "Restaurer" : "Archiver", "finance-archive", k + ":" + id) + (quoteDeletable(k, r) ? " " + btn("Supprimer le devis", "finance-delete", k + ":" + id, "danger") : "")}</div>`
        : ""),
  );
}
async function loadUsers() {
  try {
    const out = await api("state/users");
    userAccounts = out.users;
    document.querySelectorAll("[data-employee-account]").forEach((el) => {
      const u = userAccounts.find((u) =>
        same(u.employee_id, el.dataset.employeeAccount),
      );
      el.textContent = u
        ? `${roles[u.role]} · ${u.disabled ? "Compte désactivé" : "Compte actif"}`
        : "Sans compte";
    });
    if (!$("usersList")) return;
    $("usersList").innerHTML = table(
      ["Nom", "E-mail", "Rôle", "Salarié", "Statut", ""],
      out.users
        .filter(
          (u) =>
            page !== "employees" ||
            !state.employees.some(
              (e) => !e.deletedAt && same(e.id, u.employee_id),
            ),
        )
        .filter((u) => !company || u.company === company)
        .map((u) => [
          personListName(
            u,
            state.employees.find((e) => same(e.id, u.employee_id))?.photo,
          ),
          esc(u.email),
          esc(roles[u.role]),
          u.employee_id ? esc(name("employees", u.employee_id)) : "Non",
          u.disabled ? "Désactivé" : "Actif",
          btn("Modifier / relier", "edit-user", u.id) +
            " " +
            btn("Réinitialiser le mot de passe", "reset-password", u.id) +
            " " +
            (!same(u.id, profile.id) && !u.disabled
              ? btn("Désactiver", "disable-user", u.id, "danger")
              : "") +
            " " +
            (!same(u.id, profile.id)
              ? btn("Supprimer", "delete-user", u.id, "danger")
              : ""),
        ]),
    );
  } catch (e) {
    if ($("usersList")) $("usersList").textContent = e.message;
  }
}
async function employeeDetail(id) {
  const e = find("employees", id);
  if (!e || e.deletedAt) return;
  const admin = profile.role === "admin" && profile.company === "group";
  let accountHtml = "";
  if (admin) {
    try {
      userAccounts = (await api("state/users")).users;
      const u = userAccounts.find((u) => same(u.employee_id, id));
      accountHtml =
        `<h3>Compte de connexion</h3>` +
        (u
          ? `<p>${esc(u.email)} · ${esc(roles[u.role])} · ${u.disabled ? "Désactivé" : "Actif"}</p><div class="actions">${btn("Modifier le compte", "edit-user", u.id)} ${btn("Réinitialiser le mot de passe", "reset-password", u.id)} ${!same(u.id, profile.id) ? btn("Supprimer le compte", "delete-user", u.id, "danger") : ""}</div>`
          : `<p>Aucun compte de connexion.</p>${btn("Créer son compte", "linked-user", "employees:" + id, "primary")}`);
    } catch (err) {
      accountHtml = `<p class="error">${esc(err.message)}</p>`;
    }
  }
  const assignedTools = state.tools.filter((a) => same(a.employeeId, id));
  const assignedVehicles = state.vehicles.filter((a) => same(a.employeeId, id));
  const times = state.time.filter((t) => same(t.employeeId, id));
  const plans = state.planning
    .filter((t) => same(t.employeeId, id) && t.date >= today())
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const absences = state.absences.filter((t) => same(t.employeeId, id));
  const projects = state.projects.filter((p) =>
    (p.team || []).some((eid) => same(eid, id)),
  );
  const docs = state.documents.filter(
    (d) => same(d.employeeId, id) && d.category !== "identity",
  );
  const identityDocs = state.documents.filter(
    (d) => same(d.employeeId, id) && d.category === "identity",
  );
  const privateInfo = can(hr) || same(profile.employee_id, id);
  modal(
    "Fiche salarié et compte",
    `
    <div class="employee-header">${e.photo ? `<img class="employee-photo" src="${esc(e.photo)}" alt="Photo de ${esc(e.name)}">` : `<div class="employee-photo employee-placeholder" aria-label="Photo non renseignée">${esc(e.name.slice(0, 1))}</div>`}
    <div><h3>${esc(e.name)}</h3><p>${esc(e.job || "—")} · ${esc(e.status || "Actif")}</p><p>${[...new Set([e.company, ...(e.companies || [])])].map((c) => esc(name("companies", c))).join(" · ")}</p></div></div>
    ${can(hr) ? `<div class="actions">${btn("Modifier la fiche", "employee-edit", id, "primary")} ${btn("Entreprises / accès", "employee-companies", id)} ${btn("Supprimer le salarié", "employee-delete", id, "danger")}</div>` : ""}
    <div class="employee-summary"><article><strong>${assignedTools.length}</strong><span>Outils attribués</span></article><article><strong>${assignedVehicles.length}</strong><span>Véhicules attribués</span></article><article><strong>${times.reduce((sum, t) => sum + Number(t.hours || 0), 0).toFixed(2)} h</strong><span>Heures enregistrées visibles</span></article><article><strong>${projects.length}</strong><span>Chantiers affectés visibles</span></article></div>
    ${
      privateInfo
        ? `<details open><summary>Coordonnées et informations personnelles</summary><dl class="employee-info"><dt>E-mail de contact</dt><dd>${esc(e.email || "—")}</dd><dt>Téléphone</dt><dd>${esc(e.phone || "—")}</dd><dt>Adresse</dt><dd>${esc([e.street, e.zip, e.city, e.country].filter(Boolean).join(", ") || "Non renseignée")}</dd><dt>Date de naissance</dt><dd>${e.birthDate ? date(e.birthDate) : "—"}</dd><dt>Nationalité(s)</dt><dd>${esc(e.nationality || "Non renseignée")}</dd><dt>Permis de séjour</dt><dd>${esc(e.residencePermit || "Non renseigné")}</dd><dt>Expiration du permis</dt><dd>${e.residencePermitExpiry ? date(e.residencePermitExpiry) : "—"}</dd><dt>Contact d’urgence</dt><dd>${esc([e.emergencyName, e.emergencyPhone].filter(Boolean).join(" · ") || "—")}</dd></dl></details>
    <details><summary>Contrat et rémunération</summary><p>${e.salaryPeriod === "hourly" ? "Salaire horaire" : "Salaire mensuel"} : ${money(e.salary)}${e.salaryPeriod === "hourly" ? " / heure" : " / mois"}</p><p>Activité : ${esc(e.activity ?? "—")} % · Heures contractuelles : ${esc(e.weeklyHours || "—")} h/semaine · Vacances : ${esc(e.vacation ?? "—")} jours</p><p>Contrat : ${esc(e.contractType || "Non renseigné")} · Entrée : ${e.entry ? date(e.entry) : "—"} · Fin : ${e.endDate ? date(e.endDate) : "—"}</p>${can(hr) && e.notes ? `<p class="employee-notes">${esc(e.notes)}</p>` : ""}</details>`
        : ""
    }
    ${
      can(hr)
        ? `<details open><summary>Documents d’identité et justificatifs</summary><p>Documents confidentiels réservés aux personnes disposant d’un accès RH.</p>${btn("Ajouter un justificatif", "employee-document", id)}${table(
            ["Type", "Fichier / description", "Ajouté le", ""],
            identityDocs.map((d) => [
              esc(d.documentType),
              esc(d.name) + (d.description ? `<br>${esc(d.description)}` : ""),
              date(d.createdAt.slice(0, 10)),
              btn("Télécharger", "download", d.id) +
                " " +
                deleteRecordButton("documents", d),
            ]),
          )}</details>`
        : ""
    }
    <details open><summary>Outils et véhicules</summary>${can(hr) ? btn("Gérer les attributions", "employee-assets", id) : ""}<h4>Outils</h4>${table(
      ["Outil", "N° série", "Entreprise"],
      assignedTools.map((a) => [
        esc(a.name),
        esc(a.serial),
        esc(name("companies", a.company)),
      ]),
    )}<h4>Véhicules</h4>${table(
      ["Plaque", "Véhicule", "Kilométrage", "Entretien"],
      assignedVehicles.map((a) => [
        esc(a.plate),
        esc([a.brand, a.model].filter(Boolean).join(" ")),
        esc(a.km),
        a.service ? date(a.service) : "—",
      ]),
    )}</details>
    <details><summary>Planning, heures et absences</summary><h4>Prochaines affectations</h4>${table(
      ["Date", "Horaires", "Chantier"],
      plans.map((p) => [
        date(p.date),
        esc(p.start + "–" + p.end),
        esc(name("projects", p.project)),
      ]),
    )}<h4>Heures enregistrées</h4>${table(
      ["Date", "Chantier", "Heures", "Statut"],
      times.map((t) => [
        date((t.startedAt || t.date || "").slice(0, 10)),
        esc(name("projects", t.project)),
        esc(t.hours),
        esc(t.status),
      ]),
    )}<h4>Absences</h4>${table(
      ["Du", "Au", "Type", "Statut"],
      absences.map((a) => [
        date(a.from),
        date(a.to),
        esc(a.type),
        esc(a.status),
      ]),
    )}</details>
    <details><summary>Chantiers et documents</summary>${table(
      ["Chantier", "Statut", ""],
      projects.map((p) => [
        esc(p.title),
        esc(p.status),
        btn("Ouvrir", "project", p.id),
      ]),
    )}${table(
      ["Document", ""],
      docs.map((d) => [
        esc(d.name),
        btn("Télécharger", "download", d.id) +
          " " +
          deleteRecordButton("documents", d),
      ]),
    )}</details>
    ${accountHtml ? `<details><summary>Compte de connexion</summary>${accountHtml}</details>` : ""}`,
  );
}
function employeeDocument(id) {
  const e = find("employees", id);
  formShell(
    [],
    "document",
    `<input type="hidden" name="employeeId" value="${esc(id)}"><input type="hidden" name="company" value="${esc(e.company)}"><input type="hidden" name="category" value="identity"><label>Type de document<select name="documentType">${["Carte d’identité", "Passeport", "Permis de conduire", "Permis de séjour", "Autre justificatif"].map((t) => `<option>${esc(t)}</option>`).join("")}</select></label><label>Description (facultative)<input name="description" maxlength="200" placeholder="Par exemple : recto ou verso"></label><label>Photo ou fichier<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></label><p>JPG, PNG, WebP ou PDF, 5 Mo maximum par fichier. Ajoutez le recto et le verso séparément. Accès réservé aux RH.</p>`,
    "Ajouter un justificatif — " + e.name,
  );
}
function employeeEdit(id) {
  const e = find("employees", id);
  formShell(
    schemas.employees.filter((f) => f[0] !== "company"),
    "employee.update",
    `<input type="hidden" name="id" value="${esc(id)}"><fieldset><legend>Photo</legend>${e.photo ? `<img class="employee-photo" src="${esc(e.photo)}" alt="Photo actuelle"><label><input type="checkbox" name="removePhoto"> Retirer la photo actuelle</label>` : ""}<label for="employeePhoto">Photo du salarié</label><input id="employeePhoto" type="file" name="photoFile" accept="image/jpeg,image/png,image/webp"><p>JPG, PNG ou WebP, 5 Mo maximum. La photo sera redimensionnée.</p></fieldset><p class="muted">L’e-mail de contact ne modifie pas l’identifiant du compte de connexion.</p>`,
    "Modifier la fiche salarié",
  );
  for (const [key] of schemas.employees)
    if (key !== "company" && $("f_" + key))
      $("f_" + key).value = e[key] ?? (key === "salaryPeriod" ? "monthly" : "");
  $("f_salary").labels[0].textContent =
    e.salaryPeriod === "hourly"
      ? "Salaire horaire (CHF/heure)"
      : "Salaire mensuel (CHF/mois)";
}
function employeeAssets(id) {
  const e = find("employees", id),
    companies = [e.company, ...(e.companies || [])];
  formShell(
    [],
    "employee.assets",
    `<input type="hidden" name="id" value="${esc(id)}"><p>Choisissez les équipements confiés à ${esc(e.name)}. Décochez-les lors de leur restitution.</p>${[
      "tools",
      "vehicles",
    ]
      .map(
        (k) =>
          `<fieldset><legend>${k === "tools" ? "Outils" : "Véhicules"}</legend>${
            state[k]
              .filter(
                (a) => companies.includes(a.company) || same(a.employeeId, id),
              )
              .map(
                (a) =>
                  `<label class="asset-choice"><input type="checkbox" name="${k}" value="${esc(a.id)}" ${same(a.employeeId, id) ? "checked" : ""} ${a.employeeId && !same(a.employeeId, id) ? "disabled" : ""}> ${esc(k === "tools" ? a.name + " · " + a.serial : a.plate + " · " + a.brand + " " + a.model)} — ${esc(name("companies", a.company))}${a.employeeId && !same(a.employeeId, id) ? " (déjà attribué)" : ""}</label>`,
              )
              .join("") ||
            "<p>Aucun équipement enregistré pour ses entreprises.</p>"
          }</fieldset>`,
      )
      .join("")}`,
    "Attributions du salarié",
  );
}
async function employeePhoto(file) {
  if (!file || !file.size) return undefined;
  if (
    file.size > 5 * 1024 * 1024 ||
    !["image/jpeg", "image/png", "image/webp"].includes(file.type)
  )
    throw new Error("Choisissez une photo JPG, PNG ou WebP de 5 Mo maximum.");
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
async function loadAudit() {
  try {
    const out = await api("state/audit");
    if ($("auditList"))
      $("auditList").innerHTML = table(
        ["Date", "Utilisateur", "Action", "Référence"],
        out.rows.map((r) => [
          esc(new Date(r.created_at).toLocaleString("fr-CH")),
          esc(r.user_email),
          esc(r.action),
          esc(r.metadata?.id),
        ]),
      );
  } catch (e) {
    if ($("auditList")) $("auditList").textContent = e.message;
  }
}
function userForm(link) {
  formShell(
    [
      ["name", "Nom"],
      ["email", "E-mail", "email"],
      ["password", "Mot de passe initial (12 caractères minimum)", "password"],
      ["company", "Entreprise", "@companies"],
      ["employeeId", "Fiche salarié", "@employees?"],
      ["clientId", "Fiche client", "@clients?"],
    ],
    "user",
    `<label for="f_isEmployee">Cette personne est-elle un salarié ?</label><select id="f_isEmployee" name="isEmployee"><option value="no">Non — compte sans fiche salarié</option><option value="yes">Oui — compte lié à un salarié</option></select><p class="muted">La fiche salarié et le compte seront créés ensemble. Vous pouvez aussi relier une fiche existante.</p><label for="f_role">Rôle et droits d’accès</label><select id="f_role" name="role">${Object.entries(
      roles,
    )
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        "",
      )}</select><p class="muted">Transmettez le mot de passe initial à la personne par un canal privé. Elle pourra le changer dans Mon compte.</p>`,
    "Créer un accès",
  );
  $("f_company").insertAdjacentHTML(
    "afterbegin",
    '<option value="group">Sousa Group (toutes les entreprises)</option>',
  );
  const typeChoice = $("f_isEmployee"),
    typeLabel = typeChoice.labels[0],
    typeHelp = typeChoice.nextElementSibling;
  $("f_company").after(typeLabel, typeChoice, typeHelp);
  $("f_employeeId").options[0].textContent = "Créer une nouvelle fiche salarié";
  $("f_employeeId").labels[0].textContent = "Fiche salarié";
  $("f_employeeId").insertAdjacentHTML(
    "afterend",
    `<fieldset id="newEmployeeFields"><legend>Informations du nouveau salarié</legend>${[
      ["employeeJob", "Fonction"],
      ["employeePhone", "Téléphone", "tel?"],
      ["employeeSalaryPeriod", "Type de salaire", "salary-period"],
      ["employeeSalary", "Salaire mensuel (CHF/mois)", "number"],
      ["employeeActivity", "Taux d’activité %", "number", "100"],
      ["employeeWeeklyHours", "Heures hebdomadaires contractuelles", "number", "42"],
      ["employeeVacation", "Solde de vacances (jours)", "number", "20"],
      ["employeeEntry", "Date d’entrée", "date"],
    ]
      .map(field)
      .join("")}</fieldset>`,
  );
  $("f_clientId").options[0].textContent = "Créer une nouvelle fiche client";
  $("f_clientId").labels[0].textContent = "Fiche client";
  $("f_clientId").insertAdjacentHTML(
    "afterend",
    `<fieldset id="newClientFields"><legend>Informations du nouveau client</legend><p>Le nom, l’e-mail et l’entreprise du compte seront repris dans la fiche client.</p>${[
      ["clientPhone", "Téléphone", "tel?"],
      ["clientStreet", "Rue", "text?"],
      ["clientBuildingNumber", "Numéro", "text?"],
      ["clientZip", "Code postal", "text?"],
      ["clientCity", "Ville"],
      ["clientCountry", "Pays (code)", "text", "CH"],
      ["clientType", "Type de client", "text", "Particulier"],
    ]
      .map(field)
      .join("")}</fieldset>`,
  );
  $("f_employeeId").insertAdjacentHTML(
    "afterend",
    `<fieldset id="accountCompanies"><legend>Entreprises du salarié</legend><p>Cochez les entreprises autorisées. Le rôle définit les fonctions disponibles dans chacune d’elles. Avec le rôle Salarié, seuls les chantiers affectés sont accessibles. Un accès Groupe conserve son périmètre global.</p>${state.companies
      .filter((c) => c.id !== "group")
      .map(
        (c) =>
          `<label><input type="checkbox" name="employeeCompanies" value="${esc(c.id)}"> ${esc(c.name)}</label>`,
      )
      .join("")}</fieldset>`,
  );
  $("f_role").value = "manager";
  if (link) {
    const [k, id] = link.split(":"),
      r = find(k, id);
    if (r) {
      $("f_name").value = r.name;
      $("f_email").value = r.email;
      $("f_company").value = r.company;
      $("f_role").value = k === "employees" ? "employee" : "client";
      $(k === "employees" ? "f_employeeId" : "f_clientId").value = r.id;
    }
  }
  $("f_isEmployee").value = $("f_employeeId").value ? "yes" : "no";
  syncUserForm();
}
function syncUserForm() {
  const employee = $("f_isEmployee").value === "yes",
    client = $("f_role").value === "client";
  const e = $("f_employeeId"),
    c = $("f_clientId");
  e.disabled = !employee;
  e.required = false;
  e.hidden = !employee;
  e.labels[0].hidden = !employee;
  e.classList.toggle("hidden", !employee);
  e.labels[0].classList.toggle("hidden", !employee);
  c.disabled = !client;
  c.required = false;
  c.hidden = !client;
  c.labels[0].hidden = !client;
  c.classList.toggle("hidden", !client);
  c.labels[0].classList.toggle("hidden", !client);
  if (!employee) e.value = "";
  if (!client) c.value = "";
  const fields = $("newEmployeeFields"),
    createEmployee = employee && !e.value;
  fields.disabled = !createEmployee;
  fields.classList.toggle("hidden", !createEmployee);
  const membershipFields = $("accountCompanies"),
    linkedEmployee = find("employees", e.value);
  membershipFields.disabled = !employee;
  membershipFields.classList.toggle("hidden", !employee);
  const source = e.value || "new";
  if (membershipFields.dataset.source !== source) {
    const assigned = linkedEmployee
      ? [linkedEmployee.company, ...(linkedEmployee.companies || [])]
      : [];
    membershipFields
      .querySelectorAll("input")
      .forEach((x) => (x.checked = assigned.includes(x.value)));
    membershipFields.dataset.source = source;
  }
  const primary = linkedEmployee?.company || $("f_company").value;
  membershipFields.querySelectorAll("input").forEach((x) => {
    if (x.value === primary) x.checked = true;
  });
  const clientFields = $("newClientFields"),
    createClient = client && !c.value;
  clientFields.disabled = !createClient;
  clientFields.classList.toggle("hidden", !createClient);
}
function downloadBlob(blob, name) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
function exportData(k) {
  const rows = visible(k);
  if (!rows.length) return toast("Aucune donnée à exporter.");
  const keys = [...new Set(rows.flatMap(Object.keys))].filter(
    (k) => !["lines", "team"].includes(k),
  );
  const csv = [keys, ...rows.map((r) => keys.map((k) => r[k] ?? ""))]
    .map((row) => row.map(csvCell).join(";"))
    .join("\r\n");
  downloadBlob(
    new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }),
    "Sousa_" + k + ".csv",
  );
}
document.addEventListener("change", (e) => {
  if (["f_salaryPeriod", "f_employeeSalaryPeriod"].includes(e.target.id)) {
    const amount = $(
      e.target.id === "f_salaryPeriod" ? "f_salary" : "f_employeeSalary",
    );
    amount.labels[0].textContent =
      e.target.value === "hourly"
        ? "Salaire horaire (CHF/heure)"
        : "Salaire mensuel (CHF/mois)";
  }
  if (
    $("entityForm")?.dataset.kind === "user" &&
    [
      "f_isEmployee",
      "f_role",
      "f_employeeId",
      "f_clientId",
      "f_company",
    ].includes(e.target.id)
  ) {
    if (e.target.id === "f_isEmployee") {
      if (e.target.value === "yes") $("f_role").value = "employee";
      else if ($("f_role").value === "employee") $("f_role").value = "manager";
    } else if (e.target.value === "employee") $("f_isEmployee").value = "yes";
    else if (e.target.value === "client") $("f_isEmployee").value = "no";
    syncUserForm();
  }
  if (
    e.target.id === "f_employeeId" &&
    ["planning", "time.add"].includes($("entityForm")?.dataset.kind)
  )
    planningProjects();
  if (
    e.target.id === "planningDate" &&
    /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)
  ) {
    planningDate = e.target.value;
    render();
  }
  if (e.target.id === "planningEmployee") {
    planningEmployee = e.target.value;
    render();
  }
  if (e.target.id === "recipient") {
    selectedRecipient = e.target.value;
    render();
  }
});
document.addEventListener("click", async (e) => {
  const section = e.target.closest("[data-section]");
  const nav = section || e.target.closest("[data-page], [data-shortcut]");
  if (nav) {
    let nextPage = nav.dataset.page || nav.dataset.shortcut;
    if (section) {
      const sec = availableSections().find((x) => x.id === section.dataset.section);
      if (!sec) return;
      nextPage = sec.pages.includes(lastPageIn[sec.id]) ? lastPageIn[sec.id] : sec.pages[0];
    }
    if (page === "messages" && nextPage !== "messages") cancelChatRecording();
    page = nextPage;
    if (page === "messages") mobileChatOpen = false;
    render();
    $("sidebar").classList.remove("open");
    $("backdrop").classList.add("hidden");
    document.querySelector('[data-action="open-side"]')?.setAttribute("aria-expanded", "false");
    return;
  }
  const b = e.target.closest("[data-action]");
  if (!b || pending) return;
  const a = b.dataset.action,
    id = b.dataset.id;
  try {
    if (
      chatSending &&
      [
        "chat-reply",
        "chat-cancel-reply",
        "chat-file",
        "chat-voice",
        "chat-cancel-attachment",
      ].includes(a)
    )
      return;
    if (a === "chat-select") {
      selectChat(String(id));
      mobileChatOpen = true;
      render();
    } else if (a === "chat-latest") {
      const thread = $("messageThread");
      if (thread) {
        thread.scrollTop = thread.scrollHeight;
        thread.focus({ preventScroll: true });
      }
      updateChatScrollButton();
    } else if (a === "chat-load-older") {
      const key = chatKey(),
        current = chatMessageLimits.get(key) || 120,
        anchorId = id,
        out = await api(
          "messaging/history?key=" +
            encodeURIComponent(key) +
            "&beforeId=" +
            encodeURIComponent(anchorId) +
            "&limit=100",
        );
      const known = new Set((state.messages || []).map((message) => String(message.id)));
      const added = [];
      for (const message of out.messages || [])
        if (!known.has(String(message.id))) {
          state.messages.push(message);
          added.push(message);
          known.add(String(message.id));
        }
      const cached = chatHistoryCache.get(key) || [],
        cachedIds = new Set(cached.map((message) => String(message.id)));
      for (const message of added)
        if (!cachedIds.has(String(message.id))) cached.push(message);
      chatHistoryCache.set(key, cached);
      messageStats[key] = {
        ...(messageStats[key] || {}),
        total: Number(out.total || messageStats[key]?.total || state.messages.length),
      };
      chatMessageLimits.set(key, current + Math.max(added.length, 100));
      render();
      requestAnimationFrame(() =>
        document.getElementById("msg-" + anchorId)?.scrollIntoView({ block: "start" }),
      );
    } else if (a === "chat-back") {
      mobileChatOpen = false;
      render();
    } else if (a === "call-start") await startAudioCall(id);
    else if (a === "call-video") await startVideoCall(id);
    else if (a === "call-accept") await acceptIncomingCall();
    else if (a === "call-reject") await rejectIncomingCall();
    else if (a === "call-hangup") await endCurrentCall(true);
    else if (a === "call-enable-audio") await playRemoteAudio();
    else if (a === "call-camera") {
      if (!activeCall?.stream) return;
      const tracks = activeCall.stream.getVideoTracks(),
        disabled = tracks.length && tracks.every((track) => !track.enabled);
      tracks.forEach((track) => (track.enabled = disabled));
      b.classList.toggle("muted", !disabled);
      b.innerHTML = uiIcon(disabled ? "video" : "video-off");
      b.title = disabled ? "Couper la caméra" : "Réactiver la caméra";
    } else if (a === "call-mute") {
      if (!activeCall?.stream) return;
      const tracks = activeCall.stream.getAudioTracks(),
        muted = tracks.every((track) => !track.enabled);
      tracks.forEach((track) => (track.enabled = muted));
      b.classList.toggle("muted", !muted);
      b.innerHTML = uiIcon(muted ? "mic" : "mic-off");
      b.title = muted ? "Couper le micro" : "Réactiver le micro";
    } else if (a === "chat-new-group") threadForm("group");
    else if (a === "chat-new-project") threadForm("project");
    else if (a === "chat-open-project") {
      page = "messages";
      selectedThreadId = String(id);
      selectedRecipient = "";
      mobileChatOpen = true;
      closeModal();
      render();
    } else if (a === "chat-create-project") {
      closeModal();
      threadForm("project", String(id));
    } else if (a === "chat-reply") {
      chatReplyToId = String(id);
      render();
      $("messageText")?.focus();
    } else if (a === "chat-cancel-reply") {
      chatReplyToId = "";
      render();
      $("messageText")?.focus();
    } else if (a === "chat-cancel-attachment") {
      chatAttachmentDraft = null;
      render();
      $("messageText")?.focus();
    } else if (a === "chat-jump") {
      document.getElementById("msg-" + id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (a === "chat-file") $("chatFile")?.click();
    else if (a === "chat-open-attachment") {
      const r = await fetch("/api/state/messages/" + encodeURIComponent(id) + "/attachment", {
        credentials: "same-origin",
      });
      if (!r.ok) throw new Error("Pièce jointe inaccessible.");
      const blob = await r.blob(),
        url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else if (a === "chat-voice") {
      if (activeCall || incomingCall)
        throw new Error(
          "Terminez l’appel avant d’enregistrer un message vocal.",
        );
      if (chatRecorder?.state === "recording") {
        chatRecorder.stop();
        markVoiceButtons(false);
      } else {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
          throw new Error(
            "Enregistrement vocal non disponible sur cet appareil.",
          );
        let stream;
        const mediaGeneration = chatMediaGeneration;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          if (mediaGeneration !== chatMediaGeneration) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          const preferred = [
              "audio/webm;codecs=opus",
              "audio/mp4",
              "audio/webm",
              "audio/ogg;codecs=opus",
            ].find((type) => MediaRecorder.isTypeSupported?.(type)),
            chunks = [],
            recorder = preferred
              ? new MediaRecorder(stream, { mimeType: preferred })
              : new MediaRecorder(stream);
          chatRecordingDiscard = false;
          chatRecorder = recorder;
          recorder.ondataavailable = (event) => {
            if (event.data.size) chunks.push(event.data);
          };
          recorder.onerror = () => {
            stream.getTracks().forEach((track) => track.stop());
            chatRecorder = null;
            notice("L’enregistrement vocal a été interrompu.");
            render();
          };
          recorder.onstop = async () => {
            stream.getTracks().forEach((track) => track.stop());
            if (
              chatRecordingDiscard ||
              mediaGeneration !== chatMediaGeneration
            ) {
              if (chatRecorder === recorder) {
                chatRecordingDiscard = false;
                chatRecorder = null;
              }
              return;
            }
            const mime = (recorder.mimeType || preferred || "audio/webm").split(
                ";",
              )[0],
              blob = new Blob(chunks, { type: mime });
            chatRecorder = null;
            if (!blob.size) {
              notice("Aucun son n’a été enregistré.");
              render();
              return;
            }
            if (blob.size > 5 * 1024 * 1024) {
              notice("Message vocal trop volumineux (5 Mo maximum).");
              render();
              return;
            }
            const content = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(",")[1]);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            const extension =
              mime.includes("mp4") || mime.includes("m4a")
                ? "m4a"
                : mime.includes("ogg")
                  ? "ogg"
                  : mime.includes("mpeg")
                    ? "mp3"
                    : "webm";
            if (mediaGeneration !== chatMediaGeneration) return;
            chatAttachmentDraft = {
              name: "message-vocal-" + Date.now() + "." + extension,
              mime,
              content,
              kind: "audio",
            };
            render();
          };
          recorder.start(250);
          // The screen may have been redrawn while the microphone was being opened.
          markVoiceButtons(true);
        } catch (e) {
          stream?.getTracks().forEach((track) => track.stop());
          chatRecorder = null;
          throw new Error(friendlyMediaError(e, "vocal"));
        }
      }
    } else if (a === "close-modal") closeModal();
    else if (a === "open-side") {
      $("sidebar").classList.add("open");
      $("backdrop").classList.remove("hidden");
      document.querySelector('[data-action="open-side"]')?.setAttribute("aria-expanded", "true");
    } else if (a === "close-side") {
      $("sidebar").classList.remove("open");
      $("backdrop").classList.add("hidden");
      document.querySelector('[data-action="open-side"]')?.setAttribute("aria-expanded", "false");
      document.querySelector('[data-action="open-side"]')?.focus();
    } else if (a === "logout") {
      await api("auth/logout", {});
      clearSession();
    } else if (a === "theme") {
      document.body.classList.toggle("light");
      localStorage.setItem(
        "sgo_theme",
        document.body.classList.contains("light") ? "light" : "dark",
      );
    } else if (a === "refresh") {
      await refresh();
      notice("");
      toast("Données actualisées.");
    } else if (a === "planning-nav") {
      planningDate =
        id === "today" ? today() : planningDay(planningDate, Number(id));
      render();
    } else if (a === "planning-mode") {
      planningMode = id === "list" ? "list" : "week";
      render();
    } else if (a === "planning-slot") {
      planningForm(b.dataset.employee, b.dataset.date);
    } else if (a === "go-to") {
      if (navApp()) openNavigation(navUrl(id));
      else chooseNavApp(id);
    } else if (a === "go-app") {
      try {
        if ($("goRemember")?.checked) localStorage.setItem("sgo-nav-app", id);
      } catch {}
      const address = goPending;
      goPending = "";
      closeModal(true);
      if (address) openNavigation(navUrl(address, id));
      if (page === "planning") render();
    } else if (a === "go-app-reset") {
      try {
        localStorage.removeItem("sgo-nav-app");
      } catch {}
      goPending = "";
      modal(
        "Application pour les itinéraires",
        `<p class="muted">Choisissez l’application qui s’ouvre avec « Y aller » sur cet appareil.</p><div class="go-apps">${Object.entries(NAV_APPS)
          .map(([key, label]) => `<button type="button" class="btn secondary" data-action="go-app" data-id="${key}">${esc(label)}</button>`)
          .join("")}</div><input type="checkbox" id="goRemember" checked hidden>`,
      );
    } else if (a === "go-tour") {
      const stops = todayStops(id);
      if (!stops.length) toast("Aucune adresse prévue aujourd’hui.");
      else if (stops.length === 1) {
        if (navApp()) openNavigation(navUrl(stops[0]));
        else chooseNavApp(stops[0]);
      } else openNavigation(tourUrl(stops));
    } else if (a === "planning-detail") {
      const p = find("planning", id);
      if (p)
        modal(
          "Affectation",
          `<p><b>${esc(name("employees", p.employeeId))}</b></p><p>${date(p.date)} · ${esc(p.start)}–${esc(p.end)}</p><p>${esc(name("projects", p.project))}</p><p>${esc(p.location)}</p>${planningAddress(p) && planningAddress(p) !== p.location ? `<p class="muted">${esc(planningAddress(p))}</p>` : ""}<p>${goButton(planningAddress(p))}</p>${can(ops) ? btn("Copier vers un autre créneau", "planning-copy", p.id) + " " + btn("Supprimer", "planning.delete", p.id, "danger") : ""}`,
        );
    } else if (a === "planning-copy") {
      const p = find("planning", id);
      if (p) planningForm(p.employeeId, planningDay(p.date, 1), p);
    } else if (a === "new") {
      if (id === "planning") planningForm(planningEmployee);
      else newForm(id);
    } else if (a === "finance-archives") {
      showArchivedFinance = !showArchivedFinance;
      render();
    } else if (a === "finance-delete" || a === "finance-archive") {
      const [kind, rid] = id.split(":");
      const r = find(kind, rid);
      if (
        confirm(
          a === "finance-delete"
            ? r.status === "Brouillon"
              ? `Supprimer le brouillon ${rid} ?`
              : `Supprimer définitivement le devis ${rid} ? Il disparaîtra des listes et le client ne pourra plus le consulter ni l’accepter.`
            : r.archivedAt
              ? `Restaurer ${rid} ?`
              : `Archiver ${rid} ? Les montants, paiements et l’historique restent conservés.`,
        )
      ) {
        const out = await mutate(
          a === "finance-delete" ? "finance.delete" : "finance.archive",
          { kind, id: rid, restore: !!r.archivedAt },
        );
        if (out) closeModal();
      }
    } else if (a === "quote-project") {
      const q = find("quotes", id);
      const project = q.project
        ? find("projects", q.project)
        : await mutate("quote.project", { id });
      if (project) {
        page = "projects";
        render();
        projectModal(project.id);
      }
    } else if (a === "record-delete") {
      const split = id.indexOf(":"),
        kind = id.slice(0, split),
        rid = id.slice(split + 1);
      const record = find(kind, rid);
      const trashable = ["documents", "inventory", "suppliers", "vehicles", "tools", "maintenance"].includes(kind);
      const prompt =
        kind === "messages"
          ? "Masquer ce message pour vous ? Il restera visible pour votre interlocuteur."
          : trashable
            ? `Mettre cet élément (${record?.name || record?.title || record?.id || rid}) dans la corbeille pendant 30 jours ?`
            : `Supprimer définitivement cet élément (${record?.name || record?.title || record?.id || rid}) ? Cette action est irréversible. Les totaux associés seront mis à jour. La suppression peut être bloquée si l’élément est lié à d’autres données.`;
      if (record && confirm(prompt)) {
        if (trashable) {
          await api("pro/trash", { kind, id: rid });
          await refresh();
          toast("Élément déplacé dans la corbeille.");
        } else {
          const result = await mutate("record.delete", { kind, id: rid });
          if (result)
            toast(
              kind === "messages"
                ? "Message supprimé pour vous."
                : "Élément supprimé.",
            );
        }
      }
    } else if (a === "client-edit") {
      clientEdit(id);
    } else if (a === "client-card") {
      clientCard(id);
    } else if (a === "site-add") {
      const rows = b.closest(".site-list").querySelector(".site-rows");
      rows.insertAdjacentHTML("beforeend", siteRow({}));
      rows.lastElementChild.querySelector(".site-label").focus();
    } else if (a === "site-remove") {
      b.closest("[data-site-row]").remove();
    } else if (a === "contact-add") {
      const list = b.closest(".contact-list");
      list.querySelector(".contact-rows").insertAdjacentHTML("beforeend", contactRow(id, {}, list.querySelectorAll(".contact-row").length));
      list.querySelector(".contact-row:last-child .contact-value").focus();
    } else if (a === "contact-remove") {
      const list = b.closest(".contact-list");
      b.closest(".contact-row").remove();
      if (list.dataset.contactKind === "emails" && !list.querySelector(".contact-row")) list.querySelector(".contact-rows").insertAdjacentHTML("beforeend", contactRow("emails", {}, 0));
      renumberContacts(list);
    } else if (a === "contact-main") {
      const row = b.closest(".contact-row"),
        list = b.closest(".contact-list");
      list.querySelector(".contact-rows").prepend(row);
      renumberContacts(list);
    } else if (a === "client-delete") {
      const client = find("clients", id);
      if (
        client &&
        confirm(
          `Mettre le client « ${client.name} » dans la corbeille pendant 30 jours ? Ses données liées sont conservées.`,
        )
      ) {
        await api("pro/trash", { kind: "clients", id });
        await refresh();
        closeModal(true);
        toast("Client déplacé dans la corbeille.");
      }
    } else if (a === "project-delete") {
      const project = find("projects", id);
      if (
        project &&
        confirm(
          `Mettre le chantier « ${project.title} » dans la corbeille pendant 30 jours ? Les heures, documents, devis et factures liés sont conservés.`,
        )
      ) {
        await api("pro/trash", { kind: "projects", id });
        await refresh();
        closeModal(true);
        toast("Chantier déplacé dans la corbeille.");
      }
    } else if (a === "project-finish") {
      if (
        confirm(
          "Terminer ce chantier et préparer sa facturation ? Les prestations du devis seront reprises. Vérifiez les suppléments avant d’émettre la facture.",
        )
      ) {
        const result = await mutate("project.finish", { id });
        if (result) {
          closeModal();
          if (can(fin)) {
            page = "invoices";
            render();
            if (result.invoiceIds?.[0])
              documentModal("invoices", result.invoiceIds[0]);
          } else projectModal(id);
        }
      }
    } else if (a === "project") projectModal(id);
    else if (a === "quote" || a === "invoice")
      documentModal(a === "quote" ? "quotes" : "invoices", id);
    else if (a === "print") window.print();
    else if (a === "billing-settings") billingSettings();
    else if (a === "finance-edit") {
      const [k, rid] = id.split(":");
      financeForm(k, find(k, rid));
    } else if (a === "finance-client") {
      financeClientDraft = {
        kind: id,
        value: {
          ...Object.fromEntries(new FormData($("entityForm"))),
          lines: financeLines(),
        },
      };
      newForm("clients");
      $("f_company").value = financeClientDraft.value.company;
      $("entityForm").dataset.returnFinance = "true";
    } else if (a === "finance-copy") {
      const [k, rid] = id.split(":");
      await mutate("finance.duplicate", {
        kind: k,
        id: rid,
        date: today(),
        valid: afterDays(today()),
        due: afterDays(today()),
      });
    } else if (a === "quote-convert") {
      formShell(
        [
          ["date", "Date de facture", "date", today()],
          ["due", "Échéance", "date", afterDays(today())],
        ],
        "quote.convert",
        `<input type="hidden" name="id" value="${esc(id)}"><p>Les prestations, remises, TVA et coordonnées du devis seront reprises.</p>`,
        "Convertir en facture",
      );
    } else if (a === "quote-decision") {
      const q = find("quotes", id);
      const expired = q?.valid && q.valid < today();
      formShell(
        [["note", "Référence de la réponse du client", "textarea"]],
        "quote.decide",
        `<input type="hidden" name="id" value="${esc(id)}">${expired ? `<p class="notice warning">Ce devis est expiré depuis le ${date(q.valid)}. Vous pouvez quand même enregistrer la réponse du client ; s’il accepte, vérifiez que les prix sont toujours valables.</p>` : ""}<label>Réponse<select name="status"><option>Accepté</option><option>Refusé</option></select></label>`,
        "Enregistrer la réponse reçue",
      );
    } else if (a === "invoice-payment") {
      newForm("payments");
      $("f_invoice").value = id;
      const invoice = find("invoices", id);
      $("f_amount").value =
        SousaFinance.paymentSummary(invoice).requested.toFixed(2);
    } else if (["finance-pdf", "finance-qr", "finance-email"].includes(a)) {
      const [k, rid] = id.split(":");
      const extension = a === "finance-email" ? "eml" : "pdf";
      const includeQR =
        a === "finance-qr" ||
        (a === "finance-email" &&
          k === "invoices" &&
          confirm(
            "Inclure le QR bancaire ? Choisissez Annuler pour préparer le PDF sans QR.",
          ));
      const response = await fetch(
        `/api/state/finance/${k}/${encodeURIComponent(rid)}.${extension}${includeQR ? "?qr=1" : ""}`,
        { credentials: "same-origin" },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).error || "Téléchargement impossible.",
        );
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement("a");
      link.href = url;
      link.download = rid + "." + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (extension === "eml")
        toast(
          "Brouillon téléchargé : ouvrez-le dans votre messagerie pour l’envoyer. Aucun e-mail envoyé par l’application.",
        );
    } else if (a === "add-line")
      $("lines").insertAdjacentHTML("beforeend", lineRow());
    else if (a === "remove-line") {
      if (document.querySelectorAll(".invoice-line").length > 1)
        b.closest(".invoice-line").remove();
      financeTotals();
    } else if (a === "project-edit") {
      const p = find("projects", id);
      formShell(
        [
          ["progress", "Avancement %", "number", p.progress],
          ["plannedHours", "Heures prévues", "number?", p.plannedHours || ""],
          ["plannedMaterial", "Matériel prévu CHF hors TVA", "number?", p.plannedMaterial || ""],
          ["description", "Description", "textarea?", p.description],
        ],
        "project.update",
        `<input type="hidden" name="id" value="${esc(id)}"><label>Statut<select name="status">${["Planifié", "En cours", "Terminé", "À facturer"].map((s) => `<option ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}</select></label><label>Équipe<select name="team" multiple>${state.employees
          .filter(
            (e) =>
              !e.deletedAt &&
              [e.company, ...(e.companies || [])].includes(p.company),
          )
          .map(
            (e) =>
              `<option value="${esc(e.id)}" ${(p.team || []).some((x) => same(x, e.id)) ? "selected" : ""}>${esc(e.name)}</option>`,
          )
          .join("")}</select></label>`,
        "Modifier le chantier",
      );
    } else if (
      ["clock.start", "clock.pause", "clock.resume", "clock.stop"].includes(a)
    ) {
      const clockPayload =
        a === "clock.start" ? { project: $("clockProject").value } : {};
      if (
        window.SGOP1Suite?.clockAction &&
        ["clock.start", "clock.stop"].includes(a)
      )
        await window.SGOP1Suite.clockAction(a, clockPayload);
      else await mutate(a, clockPayload);
    }
    else if (["time.approve", "quote.issue", "invoice.issue"].includes(a))
      await mutate(a, { id });
    else if (a === "quote.accept") {
      if (confirm("Confirmer l’acceptation de ce devis ?"))
        await mutate(a, { id });
    } else if (a === "planning.delete") {
      if (confirm("Supprimer cette affectation ?")) await mutate(a, { id });
    } else if (a === "absence.approve" || a === "absence.reject")
      await mutate("absence.decide", {
        id,
        status: a === "absence.approve" ? "Approuvée" : "Refusée",
      });
    else if (a === "absence-form")
      formShell(
        [
          ...(profile.role === "employee"
            ? []
            : [["employeeId", "Salarié", "@employees"]]),
          ["from", "Du", "date"],
          ["to", "Au", "date"],
          ["comment", "Commentaire", "textarea?"],
        ],
        "absence.request",
        '<label>Type<select name="type"><option>Vacances</option><option>Maladie</option><option>Autre</option></select></label><p class="muted">Le décompte exclut les samedis et dimanches. Vérifiez les jours fériés et les horaires particuliers avant validation.</p>',
        "Demande d’absence",
      );
    else if (a === "export") exportData(id);
    else if (a === "employee-detail") await employeeDetail(id);
    else if (a === "employee-edit") employeeEdit(id);
    else if (a === "employee-document") employeeDocument(id);
    else if (a === "employee-assets") employeeAssets(id);
    else if (a === "user-form") userForm();
    else if (a === "time-add") manualTimeForm();
    else if (a === "employee-companies") {
      const employee = find("employees", id);
      const memberships = [employee.company, ...(employee.companies || [])];
      formShell(
        [],
        "employee.companies",
        `<input type="hidden" name="id" value="${esc(id)}"><p>Un seul compte pour les entreprises cochées. L’entreprise principale doit rester sélectionnée. Le salarié voit uniquement les chantiers auxquels il est affecté.</p><fieldset><legend>Entreprises de ${esc(employee.name)}</legend>${state.companies
          .filter((c) => c.id !== "group")
          .map(
            (c) =>
              `<label><input type="checkbox" name="companies" value="${esc(c.id)}" ${memberships.includes(c.id) ? "checked" : ""}> ${esc(c.name)}${c.id === employee.company ? " (principale)" : ""}</label>`,
          )
          .join("")}</fieldset>`,
        "Entreprises et accès",
      );
    } else if (a === "employee-delete") {
      const employee = find("employees", id);
      if (
        confirm(
          `Supprimer ${employee.name} des salariés actifs ? Son compte sera désactivé et ses affectations à partir d’aujourd’hui annulées. L’historique des heures et documents sera conservé.`,
        )
      )
        await mutate("employee.delete", { id });
    } else if (a === "linked-user") userForm(id);
    else if (a === "edit-user") {
      const u = userAccounts.find((x) => same(x.id, id));
      userForm();
      $("f_password").required = false;
      $("f_password").labels[0].textContent =
        "Nouveau mot de passe (facultatif, 12 caractères minimum)";
      $("f_password").placeholder =
        "Laisser vide pour conserver le mot de passe";
      $("f_name").value = u.name;
      $("f_email").value = u.email;
      $("f_company").value = u.company;
      $("f_employeeId").value = u.employee_id || "";
      $("f_clientId").value = u.client_id || "";
      $("f_role").value = u.role;
      $("f_isEmployee").value = u.employee_id ? "yes" : "no";
      syncUserForm();
      $("entityForm").insertAdjacentHTML(
        "beforeend",
        `<input type="hidden" name="id" value="${esc(u.id)}">`,
      );
    } else if (a === "delete-user") {
      const u = userAccounts.find((x) => same(x.id, id));
      if (
        confirm(
          `Supprimer le compte de ${u.name} (${u.email}) ? Ses sessions seront fermées. Sa fiche salarié ou client et l’historique métier seront conservés.`,
        )
      )
        await mutate("delete", { id }, null, "state/users/delete");
    } else if (a === "disable-user") {
      if (confirm("Désactiver ce compte et ses sessions ?"))
        await mutate("disable", { id }, null, "state/users/disable");
    } else if (a === "reset-password")
      formShell(
        [["password", "Nouveau mot de passe", "password"]],
        "reset-password",
        `<input type="hidden" name="id" value="${esc(id)}">`,
        "Réinitialiser le mot de passe",
      );
    else if (a === "password-form")
      formShell(
        [
          ["currentPassword", "Mot de passe actuel", "password"],
          ["password", "Nouveau mot de passe", "password"],
        ],
        "password",
        "",
        "Changer mon mot de passe",
      );
    else if (a === "document-form")
      formShell(
        [
          ["company", "Entreprise", "@companies"],
          ["project", "Chantier", "@projects?"],
          ["employeeId", "Salarié", "@employees?"],
          ["clientId", "Client", "@clients?"],
        ],
        "document",
        '<label>Visibilité<select name="visibility"><option value="team">Équipe uniquement</option>' +
          (can(ops)
            ? '<option value="client">Partager avec le client</option>'
            : "") +
          '</select></label><p>Choisissez un seul dossier. PDF, image ou texte, 5 Mo maximum.</p><label>Fichier<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp,text/plain" required></label>',
        "Ajouter un fichier",
      );
    else if (a === "download") {
      const doc = find("documents", id),
        r = await fetch("/api/state/documents/" + encodeURIComponent(id), {
          credentials: "same-origin",
        });
      if (!r.ok) throw new Error("Téléchargement impossible ou accès expiré.");
      downloadBlob(await r.blob(), doc.name);
    }
  } catch (err) {
    notice(err.message);
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target;
  // Named form controls (e.g. name="id") shadow HTMLFormElement properties in browsers.
  const formId = f.getAttribute("id");
  if (!["entityForm", "messageForm"].includes(formId)) return;
  e.preventDefault();
  if (pending) return;
  const data = new FormData(f),
    p = Object.fromEntries(data);
  const k = f.dataset.kind;
  try {
    if (formId === "messageForm") {
      if (chatSending) return;
      chatSending = true;
      $("messageText").readOnly = true;
      f.querySelector("button[type=submit]").disabled = true;
      const sendingKey = f.dataset.conversation;
      try {
        let payload = {
          text: p.text || "",
          recipientId: selectedThreadId ? null : selectedRecipient,
          threadId: selectedThreadId || "",
          replyToId: chatReplyToId || "",
          attachment: chatAttachmentDraft,
        };
        if (window.SGOMessagingSuite?.prepareOutgoingMessage)
          payload =
            await window.SGOMessagingSuite.prepareOutgoingMessage(payload);
        const result = await mutate(
          "message",
          payload,
          null,
          "state/messages",
          f,
        );
        if (result) {
          // Refresh during mutate preserved the sent draft; clear only that conversation.
          chatTextDrafts.delete(sendingKey);
          if ($("messageForm")?.dataset.conversation === sendingKey)
            $("messageText").value = "";
          if (chatKey() === sendingKey) {
            chatReplyToId = "";
            chatAttachmentDraft = null;
          }
          render();
        }
        return result;
      } finally {
        chatSending = false;
        if ($("messageText")) $("messageText").readOnly = false;
        const sendButton = $("messageForm")?.querySelector(
          "button[type=submit]",
        );
        if (sendButton) sendButton.disabled = false;
      }
    }
    if (k === "message.thread") {
      p.participants = data.getAll("participants");
      if (p.type !== "project") p.projectId = "";
      const result = await mutate(
        "message.thread",
        p,
        null,
        "state/message-threads",
        f,
      );
      if (result?.id) {
        selectedThreadId = String(result.id);
        selectedRecipient = "";
        mobileChatOpen = true;
        render();
      }
      return result;
    }
    if (k === "employee.update") {
      const photo = await employeePhoto(data.get("photoFile"));
      delete p.photoFile;
      if (photo !== undefined) p.photo = photo;
      else if (p.removePhoto) p.photo = "";
      delete p.removePhoto;
    }
    if (k === "employee.assets") {
      p.tools = data.getAll("tools");
      p.vehicles = data.getAll("vehicles");
    }
    if (k === "password") {
      await api("auth/password", p);
      clearSession();
      toast("Mot de passe changé. Reconnectez-vous.");
      return;
    }
    if (k === "document") {
      const file = data.get("file");
      if (!file.size || file.size > 5 * 1024 * 1024)
        throw new Error("Choisissez un fichier de 5 Mo maximum.");
      const content = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      delete p.file;
      const result = await mutate(
        "document",
        { ...p, name: file.name, mime: file.type, content },
        null,
        "state/documents",
        f,
      );
      if (result && p.category === "identity")
        await employeeDetail(p.employeeId);
      return;
    }
    if (k === "user" && p.isEmployee === "yes")
      p.employeeCompanies = data.getAll("employeeCompanies");
    if (k === "user" && p.isEmployee === "yes" && !p.employeeId) {
      p.newEmployee = {
        job: p.employeeJob,
        phone: p.employeePhone,
        salary: p.employeeSalary,
        salaryPeriod: p.employeeSalaryPeriod,
        activity: p.employeeActivity,
        weeklyHours: p.employeeWeeklyHours,
        vacation: p.employeeVacation,
        entry: p.employeeEntry,
      };
    }
    if (k === "user" && p.role === "client" && !p.clientId) {
      p.newClient = {
        phone: p.clientPhone,
        street: p.clientStreet,
        buildingNumber: p.clientBuildingNumber,
        zip: p.clientZip,
        city: p.clientCity,
        country: p.clientCountry,
        type: p.clientType,
      };
    }
    if (k === "user" || k === "reset-password") {
      const account = await mutate(
        k,
        p,
        null,
        k === "user" ? "state/users" : "state/users/password",
        f,
      );
      if (account?.employeeId) await employeeDetail(account.employeeId);
      return;
    }
    if (k === "clients" || k === "client.update") Object.assign(p, readContacts(f));
    if (k === "project.update") p.team = data.getAll("team");
    if (k === "employee.companies") p.companies = data.getAll("companies");
    if (["quotes", "invoices", "finance.update"].includes(k))
      p.lines = financeLines(f);
    const result = await mutate(
      k.includes(".") ? k : "create",
      p,
      k.includes(".") ? undefined : k,
      "state/command",
      f,
    );
    if (
      result &&
      ["employees", "employee.update", "employee.assets"].includes(k)
    )
      await employeeDetail(result.id);
    if (result && k === "planning") {
      planningDate = p.date;
      render();
    }
    if (
      result &&
      k === "clients" &&
      f.dataset.returnFinance &&
      financeClientDraft
    ) {
      const draft = financeClientDraft;
      financeClientDraft = null;
      const value = {
        ...draft.value,
        clientId: result.id,
        company: result.company,
        project: "",
      };
      if (value.id) financeForm(draft.kind, value);
      else financeForm(draft.kind, null, value);
    }
  } catch (err) {
    const target = $("formError");
    if (target) target.textContent = err.message;
    else notice(err.message);
  }
});
function updateChatScrollButton() {
  const thread = $("messageThread"), button = $("chatLatest");
  if (thread && button) button.classList.toggle("hidden", thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 60);
}
document.addEventListener("scroll", (event) => {
  if (event.target.id === "messageThread") updateChatScrollButton();
}, true);
function filterChatConversations(value) {
  const q = value.trim().toLowerCase();
  document.querySelectorAll(".chat-contact").forEach((row) => {
    row.hidden = !!q && !row.dataset.search.includes(q);
  });
}
document.addEventListener("input", (e) => {
  // Typed by the person: no longer replaced when the client changes.
  if (["f_address", "f_site"].includes(e.target.id)) delete e.target.dataset.auto;
  if (e.target.closest(".invoice-line") || e.target.name === "depositPercent")
    financeTotals();
  if (e.target.id === "conversationSearch") filterChatConversations(e.target.value);
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "chatFile") {
    const file = e.target.files?.[0];
    if (!file) return;
    const mediaGeneration = chatMediaGeneration;
    const rawLimit = file.type.startsWith("video/") ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file.size > rawLimit) {
      notice(file.type.startsWith("video/") ? "Vidéo de 25 Mo maximum avant compression." : "Pièce jointe de 5 Mo maximum.");
      e.target.value = "";
      return;
    }
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    if (mediaGeneration !== chatMediaGeneration) return;
    chatAttachmentDraft = {
      name: file.name,
      mime: file.type || "application/octet-stream",
      content,
      kind: file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
            ? "audio"
            : "file",
    };
    render();
    return;
  }
  if (["f_company", "f_clientId"].includes(e.target.id)) filterFinanceClient();
  // Work address: the client's sites (chantier: or its billing address); a chosen project's address.
  if (["f_company", "f_clientId", "f_project"].includes(e.target.id) && $("entityForm")) {
    const client = find("clients", $("f_clientId")?.value);
    if ($("f_site")) {
      const project = find("projects", $("f_project")?.value);
      if (e.target.id === "f_project" && project?.address && (!$("f_site").value || $("f_site").dataset.auto)) {
        $("f_site").value = project.address === clientAddress(client) ? "" : project.address;
        $("f_site").dataset.auto = "1";
      } else fillWorkAddress($("f_site"), client);
    }
    if ($("entityForm").dataset.kind === "projects") fillWorkAddress($("f_address"), client, true);
  }
  if (
    e.target.id === "f_company" &&
    $("entityForm")?.dataset.kind === "finance.settings"
  )
    loadBillingSettings();
});
document.addEventListener("keydown", (e) => {
  if (
    e.target.id === "messageText" &&
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing
  ) {
    e.preventDefault();
    e.target.form?.requestSubmit();
    return;
  }
  if ($("modalWrap").classList.contains("hidden")) return;
  if (e.key === "Escape") closeModal();
  if (e.key === "Tab") {
    const els = [
        ...$("modalWrap").querySelectorAll("button,input,select,textarea"),
      ].filter((x) => !x.disabled && x.type !== "hidden"),
      first = els[0],
      last = els.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
document.addEventListener("pointerdown", unlockRingtoneAudio, {
  passive: true,
});
window.addEventListener("offline", () => {
  document.body.classList.add("offline-mode");
  notice("Connexion perdue. Consultation possible, modifications temporairement désactivées.");
});
window.addEventListener("online", () => {
  document.body.classList.remove("offline-mode");
  notice("");
  Promise.resolve(window.SGOP2Runtime?.flushQueue?.())
    .catch(() => null)
    .finally(() => refresh().catch(() => {}));
});
window.SGOChatCore = {
  updateBadges,
  api,
  mutate,
  command,
  refresh,
  backgroundRefresh,
  render,
  modal,
  closeModal,
  toast,
  notice,
  esc,
  same,
  loadIceServers,
  startDirectCall,
  hasDirectCall: () => !!(activeCall || incomingCall),
  documentModal,
  authFetch: (path, options = {}) =>
    fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.headers || {}),
      },
    }),
  getState: () => state,
  getProfile: () => profile,
  getContacts: () => contacts,
  getPage: () => page,
  setPage: (next) => {
    if (can(menus[next]?.[1] || [])) {
      page = next;
      render();
    }
  },
  setCompany: (next) => {
    const value = String(next || "");
    if (!value || state?.companies?.some((c) => c.id === value)) {
      company = value;
      render();
    }
  },
  getCompany: () => company,
  getRevision: () => revision,
  canRefreshMessages: () =>
    !pending &&
    !chatSending &&
    !chatRecorder &&
    !$("messageText")?.value &&
    ![
      ...document.querySelectorAll(
        "#messageThread audio, #messageThread video",
      ),
    ].some((media) => !media.paused),
  getConversation: () => {
    if (!profile) return null;
    if (selectedThreadId) {
      const thread = state?.messageThreads?.find((t) =>
        same(t.id, selectedThreadId),
      );
      return thread
        ? {
            key: "thread:" + thread.id,
            type: "thread",
            id: String(thread.id),
            thread,
            participantIds: (thread.participants || []).map(Number),
          }
        : null;
    }
    if (selectedRecipient) {
      const contact = contacts.find((c) => same(c.id, selectedRecipient));
      return contact
        ? {
            key: "direct:" + contact.id,
            type: "direct",
            id: String(contact.id),
            contact,
            participantIds: [Number(profile.id), Number(contact.id)],
          }
        : null;
    }
    return null;
  },
  selectConversation: (key) => {
    if (!/^(thread|direct):/.test(String(key))) return;
    selectChat(String(key));
    page = "messages";
    mobileChatOpen = true;
    render();
  },
  goToMessages: () => {
    page = "messages";
    render();
  },
  setAttachmentDraft: (value) => {
    chatAttachmentDraft = value;
    render();
  },
  getAttachmentDraft: () => chatAttachmentDraft,
  clearReply: () => {
    chatReplyToId = "";
  },
  sendMessage: async (payload) => {
    const result = await mutate(
      "message",
      payload,
      null,
      "state/messages",
      null,
    );
    if (result) render();
    return result;
  },
};

document.body.classList.toggle(
  "light",
  localStorage.getItem("sgo_theme") !== "dark",
);
if (token)
  refresh(false)
    .then(() => {
      $("login").classList.add("hidden");
      $("app").classList.remove("hidden");
      render();
    })
    .catch((e) => {
      clearSession();
      $("loginError").textContent = e.message;
    });
setInterval(() => {
  if (token && profile) pollCallState();
}, 1500);
document.addEventListener("visibilitychange", () => {
  if (token && profile && document.visibilityState === "visible")
    pollCallState();
});
setInterval(() => {
  if (
    token &&
    !pending &&
    !chatSending &&
    !chatRecorder &&
    (page !== "messages" || window.SGOChatCore.canRefreshMessages()) &&
    $("modalWrap").classList.contains("hidden") &&
    document.visibilityState === "visible" &&
    !$("messageText")?.value
  )
    backgroundRefresh().catch((e) => notice(e.message));
}, 30000);
// Sensitive application data is never cached. The service worker is retained for push notifications.
if ("caches" in window)
  caches
    .keys()
    .then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("sgo") || k.startsWith("sousa"))
          .map((k) => caches.delete(k)),
      ),
    )
    .catch(() => {});
