/* A client's e-mail addresses and phone numbers: several of each, with a label (« Secrétariat »,
   « Ambassadeur », « Mobile »…). The first of each list is the main one: invoices, quotes and the
   automatic e-mails go to the main address. Shared by the browser and the server. */
(function (root) {
  "use strict";
  const MAX = 10;
  const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
  const clean = (v, max) => String(v ?? "").trim().slice(0, max);
  const emailKey = (v) => String(v || "").trim().toLowerCase();
  // The last nine digits: +41 79 123 45 67, 079 123 45 67 and 0041791234567 are the same number.
  const phoneKey = (v) => {
    let d = String(v || "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    return d.slice(-9);
  };

  // The addresses of a client, main one first (older records only have « email »).
  function emails(c) {
    const out = [],
      seen = new Set();
    const add = (address, label) => {
      const a = clean(address, 254),
        k = emailKey(a);
      if (!a || seen.has(k)) return;
      seen.add(k);
      out.push({ label: clean(label, 60), address: a });
    };
    if (Array.isArray(c?.emails) && c.emails.length) for (const e of c.emails) add(e?.address ?? e?.value, e?.label);
    else add(c?.email, "");
    return out;
  }
  function phones(c) {
    const out = [],
      seen = new Set();
    const add = (number, label) => {
      const n = clean(number, 40),
        k = phoneKey(n) || n;
      if (!n || seen.has(k)) return;
      seen.add(k);
      out.push({ label: clean(label, 60), number: n });
    };
    if (Array.isArray(c?.phones) && c.phones.length) for (const p of c.phones) add(p?.number ?? p?.value, p?.label);
    else {
      add(c?.phone, "");
      add(c?.mobile, "Mobile");
    }
    return out;
  }
  const hasEmail = (c, address) => {
    const k = emailKey(address);
    return !!k && emails(c).some((e) => emailKey(e.address) === k);
  };
  const hasPhone = (c, number) => {
    const k = phoneKey(number);
    return k.length >= 6 && phones(c).some((p) => phoneKey(p.number) === k);
  };
  const findByEmail = (clients, address) => (clients || []).find((c) => !c?.deletedAt && hasEmail(c, address)) || null;
  const findByPhone = (clients, number) => (clients || []).find((c) => !c?.deletedAt && hasPhone(c, number)) || null;
  // What a client can be searched by.
  const searchText = (c) => [...emails(c).map((e) => e.address + " " + e.label), ...phones(c).map((p) => p.number + " " + p.label)].join(" ");

  // What a form sends, checked: { emails:[{label,address}], phones:[{label,number}] }, or only
  // « email » / « phone » (older forms, imports), which then replace the main entry of « current ».
  function normalize(input = {}, current = null, { requireEmail = true } = {}) {
    let list;
    if (Array.isArray(input.emails)) list = input.emails.map((e) => ({ label: e?.label, address: e?.address ?? e?.value }));
    else {
      list = emails(current || {});
      if (input.email !== undefined) {
        const main = { label: list[0]?.label || "", address: input.email };
        list = [main, ...list.slice(1).filter((e) => emailKey(e.address) !== emailKey(input.email))];
      }
    }
    let numbers;
    if (Array.isArray(input.phones)) numbers = input.phones.map((p) => ({ label: p?.label, number: p?.number ?? p?.value }));
    else {
      numbers = phones(current || {});
      if (input.phone !== undefined) {
        const main = { label: numbers[0]?.label || "", number: input.phone };
        numbers = String(input.phone || "").trim()
          ? [main, ...numbers.slice(1).filter((p) => phoneKey(p.number) !== phoneKey(input.phone))]
          : numbers.slice(1);
      }
    }
    const outEmails = emails({ emails: list.filter((e) => String(e.address || "").trim()) });
    const outPhones = phones({ phones: numbers.filter((p) => String(p.number || "").trim()) });
    if (outEmails.length > MAX) throw new Error(`${MAX} adresses e-mail au maximum.`);
    if (outPhones.length > MAX) throw new Error(`${MAX} numéros au maximum.`);
    for (const e of outEmails) if (!EMAIL.test(e.address)) throw new Error(`E-mail invalide : ${e.address}`);
    for (const p of outPhones) if (p.number.replace(/\D/g, "").length < 3 || /[^\d\s+().\/-]/.test(p.number)) throw new Error(`Numéro invalide : ${p.number}`);
    if (requireEmail && !outEmails.length) throw new Error("Indiquez au moins une adresse e-mail (l’adresse principale).");
    return { email: outEmails[0]?.address || "", phone: outPhones[0]?.number || "", emails: outEmails, phones: outPhones };
  }

  const api = { emails, phones, hasEmail, hasPhone, findByEmail, findByPhone, searchText, normalize, phoneKey, emailKey, MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SGOContacts = api;
})(typeof window === "undefined" ? {} : window);
