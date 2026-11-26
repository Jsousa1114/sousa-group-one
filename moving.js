"use strict";
// Moving quotes from an inventory: the volume of the furniture (m³), the truck that fits, the
// team, the estimated hours, then the quote lines. Prices are the company's own (settings).

// Usual volumes, in m³, of furniture once loaded (protection included).
const CATALOG = [
  {
    room: "Salon",
    items: [
      ["canape3", "Canapé 3 places", 2.0],
      ["canape2", "Canapé 2 places", 1.5],
      ["angle", "Canapé d’angle", 3.0],
      ["fauteuil", "Fauteuil", 0.8],
      ["tablebasse", "Table basse", 0.3],
      ["meubletv", "Meuble TV", 0.6],
      ["tv", "Téléviseur", 0.2],
      ["biblio", "Bibliothèque / étagère haute", 1.2],
      ["buffet", "Buffet / vaisselier", 1.2],
      ["tapis", "Tapis roulé", 0.2],
      ["plante", "Grande plante", 0.3],
      ["piano", "Piano droit", 2.0],
    ],
  },
  {
    room: "Cuisine et salle à manger",
    items: [
      ["table6", "Table (6 personnes)", 1.0],
      ["table4", "Table (4 personnes)", 0.6],
      ["chaise", "Chaise", 0.25],
      ["frigo", "Réfrigérateur", 1.0],
      ["frigoam", "Frigo américain", 1.5],
      ["congel", "Congélateur", 0.8],
      ["lavevaisselle", "Lave-vaisselle", 0.5],
      ["microondes", "Micro-ondes / petit électroménager", 0.1],
    ],
  },
  {
    room: "Chambres",
    items: [
      ["litdouble", "Lit double avec matelas", 2.0],
      ["litsimple", "Lit simple avec matelas", 1.0],
      ["litenfant", "Lit d’enfant", 0.8],
      ["armoire2", "Armoire 2 portes", 1.5],
      ["armoire4", "Armoire 3–4 portes", 2.5],
      ["commode", "Commode", 0.8],
      ["chevet", "Table de nuit", 0.2],
      ["bureau", "Bureau", 0.8],
      ["chaisebureau", "Chaise de bureau", 0.3],
    ],
  },
  {
    room: "Salle de bain et buanderie",
    items: [
      ["lavelinge", "Lave-linge", 0.5],
      ["seche", "Sèche-linge", 0.5],
      ["meublesdb", "Meuble de salle de bain", 0.3],
    ],
  },
  {
    room: "Cave, garage et extérieur",
    items: [
      ["velo", "Vélo", 0.5],
      ["etagere", "Étagère de cave", 0.6],
      ["etabli", "Établi", 0.8],
      ["tablejardin", "Table de jardin", 0.8],
      ["chaisejardin", "Chaise de jardin", 0.2],
      ["barbecue", "Barbecue", 0.4],
      ["tondeuse", "Tondeuse", 0.4],
    ],
  },
  {
    room: "Cartons",
    items: [
      ["carton", "Carton standard", 0.1],
      ["cartonlivres", "Carton à livres", 0.05],
      ["penderie", "Carton penderie", 0.4],
    ],
  },
].map((g) => ({ room: g.room, items: g.items.map(([id, label, m3]) => ({ id, label, m3 })) }));
const ITEMS = new Map(CATALOG.flatMap((g) => g.items.map((i) => [i.id, { ...i, room: g.room }])));

// Starting prices, to be replaced by the company's own in « Réglages des prix ».
const DEFAULT_SETTINGS = {
  moverRate: 55,
  trucks: [
    { label: "Fourgon 12 m³", m3: 12, rate: 30 },
    { label: "Camion 20 m³", m3: 20, rate: 45 },
    { label: "Camion 40 m³", m3: 40, rate: 70 },
  ],
  kmRate: 1.8,
  cartonPrice: 3.5,
  packingPerM3: 30,
  assemblyPrice: 35,
  pianoPrice: 250,
  productivity: 1.2,
  minHours: 3,
  vatRate: 8.1,
};

const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400, expose: true });
};
const number = (v, name, min, max, fallback) => {
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    fail(`${name} manquant.`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${name} invalide.`);
  return n;
};
const round = (n, step = 0.01) => Math.round(n / step) * step;
const money = (n) => Math.round(n * 100) / 100;

function cleanSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const out = {
    moverRate: number(s.moverRate, "Tarif horaire par déménageur", 0, 1000),
    kmRate: number(s.kmRate, "Prix au kilomètre", 0, 100),
    cartonPrice: number(s.cartonPrice, "Prix du carton", 0, 100),
    packingPerM3: number(s.packingPerM3, "Prix de l’emballage par m³", 0, 1000),
    assemblyPrice: number(s.assemblyPrice, "Prix du démontage/remontage", 0, 1000),
    pianoPrice: number(s.pianoPrice, "Prix du piano", 0, 10000),
    productivity: number(s.productivity, "Rendement (m³ par déménageur et par heure)", 0.2, 10),
    minHours: number(s.minHours, "Minimum d’heures", 0, 24),
    vatRate: number(s.vatRate, "TVA", 0, 30),
  };
  const trucks = Array.isArray(s.trucks) ? s.trucks : [];
  if (!trucks.length || trucks.length > 8) fail("Indiquez entre 1 et 8 véhicules.");
  out.trucks = trucks
    .map((t) => ({
      label: String(t?.label || "").trim().slice(0, 60) || fail("Nom du véhicule manquant."),
      m3: number(t?.m3, "Volume du véhicule", 1, 200),
      rate: number(t?.rate, "Prix horaire du véhicule", 0, 1000),
    }))
    .sort((a, b) => a.m3 - b.m3);
  return out;
}

function cleanInventory(raw = {}) {
  const items = {};
  for (const [id, q] of Object.entries(raw.items || {})) {
    if (!ITEMS.has(id)) continue;
    const n = Math.round(number(q, "Quantité", 0, 999));
    if (n > 0) items[id] = n;
  }
  const custom = (Array.isArray(raw.custom) ? raw.custom : []).slice(0, 40).flatMap((c) => {
    const label = String(c?.label || "").trim().slice(0, 80);
    const qty = Math.round(number(c?.qty, "Quantité", 0, 999, 1));
    if (!label || !qty) return [];
    return [{ label, m3: round(number(c?.m3, "Volume", 0, 20, 0.5), 0.05), qty, assembly: !!c?.assembly }];
  });
  const d = raw.details || {};
  const text = (v, max) => String(v || "").trim().slice(0, max);
  const details = {
    fromAddress: text(d.fromAddress, 200),
    toAddress: text(d.toAddress, 200),
    fromFloor: Math.round(number(d.fromFloor, "Étage de départ", -3, 40, 0)),
    toFloor: Math.round(number(d.toFloor, "Étage d’arrivée", -3, 40, 0)),
    fromLift: !!d.fromLift,
    toLift: !!d.toLift,
    fromCarry: !!d.fromCarry,
    toCarry: !!d.toCarry,
    distanceKm: number(d.distanceKm, "Distance", 0, 2000, 0),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || "")) ? d.date : "",
    packing: !!d.packing,
    cartonsSupplied: Math.round(number(d.cartonsSupplied, "Cartons fournis", 0, 999, 0)),
    assembly: Math.round(number(d.assembly, "Meubles à démonter", 0, 99, 0)),
  };
  return { items, custom, details, notes: text(raw.notes, 2000) };
}

// The estimate. overrides: { movers, hours, truck } chosen by the person.
function estimate(inv, settings, overrides = {}) {
  const s = cleanSettings(settings);
  const { items, custom, details } = cleanInventory(inv);
  let volume = 0,
    count = 0,
    pianos = 0;
  const rooms = new Map();
  for (const [id, q] of Object.entries(items)) {
    const it = ITEMS.get(id);
    volume += it.m3 * q;
    count += q;
    if (id === "piano") pianos += q;
    if (!rooms.has(it.room)) rooms.set(it.room, []);
    rooms.get(it.room).push(`${q} × ${it.label}`);
  }
  for (const c of custom) {
    volume += c.m3 * c.qty;
    count += c.qty;
    if (!rooms.has("Autres objets")) rooms.set("Autres objets", []);
    rooms.get("Autres objets").push(`${c.qty} × ${c.label}`);
  }
  volume = round(volume, 0.1);
  const biggest = s.trucks[s.trucks.length - 1];
  let truck = s.trucks.find((t) => t.m3 >= volume) || biggest;
  if (overrides.truck !== undefined && overrides.truck !== "" && s.trucks[Number(overrides.truck)]) truck = s.trucks[Number(overrides.truck)];
  const trips = Math.max(1, Math.ceil(volume / truck.m3));
  const movers = overrides.movers ? Math.round(number(overrides.movers, "Nombre de déménageurs", 1, 12)) : volume <= 12 ? 2 : volume <= 30 ? 3 : 4;
  // Stairs without a lift and long carrying distances slow the loading down.
  const access =
    (details.fromLift ? 0 : Math.max(0, details.fromFloor) * 0.08) + (details.toLift ? 0 : Math.max(0, details.toFloor) * 0.08) + (details.fromCarry ? 0.1 : 0) + (details.toCarry ? 0.1 : 0);
  const work = volume ? (volume / (movers * s.productivity)) * (1 + access) : 0;
  const drive = details.distanceKm ? (details.distanceKm / 40) * (2 * trips - 1) + 0.5 : 0.5;
  const computed = Math.max(s.minHours, Math.ceil((work + drive) * 2) / 2);
  const hours = overrides.hours ? round(number(overrides.hours, "Heures", 0.5, 200), 0.5) : computed;
  const km = round(details.distanceKm * (2 * trips - 1), 1);
  const vat = s.vatRate;
  const lines = [
    {
      description: `Équipe de ${movers} déménageurs avec ${truck.label}${trips > 1 ? ` (${trips} voyages)` : ""} — estimation ${hours} h`,
      quantity: hours,
      unit: "h",
      unitPrice: money(movers * s.moverRate + truck.rate),
      vatRate: vat,
      discount: 0,
    },
  ];
  if (km > 0) lines.push({ description: `Trajets entre les deux adresses (${km} km)`, quantity: km, unit: "km", unitPrice: s.kmRate, vatRate: vat, discount: 0 });
  if (details.cartonsSupplied) lines.push({ description: "Cartons de déménagement fournis", quantity: details.cartonsSupplied, unit: "pce", unitPrice: s.cartonPrice, vatRate: vat, discount: 0 });
  if (details.packing && volume) lines.push({ description: "Emballage et déballage par nos soins", quantity: volume, unit: "m³", unitPrice: s.packingPerM3, vatRate: vat, discount: 0 });
  const assembly = details.assembly + custom.filter((c) => c.assembly).reduce((t, c) => t + c.qty, 0);
  if (assembly) lines.push({ description: "Démontage et remontage de meubles", quantity: assembly, unit: "pce", unitPrice: s.assemblyPrice, vatRate: vat, discount: 0 });
  if (pianos) lines.push({ description: "Transport de piano (supplément)", quantity: pianos, unit: "pce", unitPrice: s.pianoPrice, vatRate: vat, discount: 0 });
  const net = lines.reduce((t, l) => t + l.quantity * l.unitPrice, 0);
  const total = money(lines.reduce((t, l) => t + money(l.quantity * l.unitPrice * (1 + l.vatRate / 100)), 0));
  const access_ = [
    details.fromAddress ? `Départ : ${details.fromAddress}${details.fromFloor ? `, ${details.fromFloor}e étage` : ", rez"}${details.fromLift ? " (ascenseur)" : details.fromFloor > 0 ? " (sans ascenseur)" : ""}` : "",
    details.toAddress ? `Arrivée : ${details.toAddress}${details.toFloor ? `, ${details.toFloor}e étage` : ", rez"}${details.toLift ? " (ascenseur)" : details.toFloor > 0 ? " (sans ascenseur)" : ""}` : "",
  ].filter(Boolean);
  const scope = [
    ...access_,
    details.date ? `Date souhaitée : ${details.date.split("-").reverse().join(".")}` : "",
    `Volume estimé : ${volume} m³ (${count} objets)`,
    "",
    ...[...rooms].map(([room, list]) => `${room} : ${list.join(", ")}`),
  ]
    .filter((x, i, a) => x || (i && a[i - 1]))
    .join("\n");
  return { volume, count, truck, trips, movers, hours, computedHours: computed, km, lines, net: money(net), total, scope };
}

module.exports = { CATALOG, ITEMS, DEFAULT_SETTINGS, cleanSettings, cleanInventory, estimate };
