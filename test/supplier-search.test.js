"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { rankRows, interpret } = require("../supplier-search");
const rows = [
  {
    vendor: "em",
    article: {
      reference: "FE 0 3 X 1,5",
      designation: "Câble installation 3×1.5mm² gris",
      numero_e: "109010323",
    },
  },
  {
    vendor: "em",
    article: {
      reference: "FE 0 5 X 1,5",
      designation: "Câble installation 5×1.5mm² gris",
    },
  },
  {
    vendor: "em",
    article: {
      reference: "FLEX 3 X 1,5",
      designation: "Câble flexible 3x1,5 mm² HF",
    },
  },
  {
    vendor: "em",
    article: {
      reference: "T13",
      designation: "Prise triple encastrée blanche",
    },
  },
];
test("finds colloquial queries, accents, reordered words and typos without mixing sections", () => {
  assert.equal(rankRows(rows, "je cherche un cabl 3 x 1,5").length, 2);
  assert.equal(
    rankRows(rows, "fil souple 3x1.5")[0].row.article.reference,
    "FLEX 3 X 1,5",
  );
  assert.equal(rankRows(rows, "1,5x3 cable").length, 0);
  assert.equal(rankRows(rows, "cable 3x2,5").length, 0);
  assert.equal(rankRows(rows, "triple prise")[0].row.article.reference, "T13");
  assert.equal(
    rankRows(rows, "cable sans halogene")[0].row.article.reference,
    "FLEX 3 X 1,5",
  );
});
test("exact identifiers rank first; unknown requests do not invent products", () => {
  assert.equal(
    rankRows(rows, "109010323")[0].row.article.reference,
    "FE 0 3 X 1,5",
  );
  assert.equal(rankRows(rows, "panneau solaire").length, 0);
  assert.equal(rankRows(rows, "je cherche une baignoire").length, 0);
  assert.equal(rankRows(rows, "").length, 4);
});
test("AI reformulation cannot drop explicit dimensions or ratings, or invent a row", () => {
  assert.equal(rankRows(rows, "cable 5x2,5", ["cable"]).length, 0);
  assert.equal(rankRows(rows, "prise 16a", ["prise"]).length, 0);
  assert.equal(
    rankRows(rows, "le truc triple pour brancher", ["prise triple"])[0].row,
    rows[3],
  );
});
test("AI failures fall back, responses are bounded, cache is scoped", async () => {
  const off = await interpret("prise", "off", { configured: () => false });
  assert.equal(off.mode, "local");
  const fail = await interpret("prise", "fail", {
    configured: () => true,
    call: async () => {
      throw Error("offline");
    },
  });
  assert.equal(fail.mode, "fallback");
  let calls = 0;
  const provider = {
    configured: () => true,
    call: async () => {
      calls++;
      return {
        alternatives: [
          "prise triple",
          null,
          {},
          "x".repeat(200),
          "socle",
          "prise",
          "extra",
        ],
      };
    },
  };
  const a = await interpret("truc pour brancher", "user1", provider);
  assert.deepEqual(a.alternatives, ["prise triple", "socle", "prise"]);
  await interpret("truc pour brancher", "user1", provider);
  assert.equal(calls, 1);
  await interpret("truc pour brancher", "user2", provider);
  assert.equal(calls, 2);
});
