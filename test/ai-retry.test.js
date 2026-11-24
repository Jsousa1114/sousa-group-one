"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { callAi } = require("../p3-intelligence-routes");

const ENV = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_FALLBACK_MODEL", "AI_REASONING_EFFORT"];

async function withProvider(env, answers, fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const calls = [];
  Object.assign(process.env, { AI_API_URL: "https://ai.test/v1/chat/completions", AI_API_KEY: "test-key", AI_MODEL: "primary" });
  delete process.env.AI_FALLBACK_MODEL;
  delete process.env.AI_REASONING_EFFORT;
  Object.assign(process.env, env);
  console.warn = () => {};
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const [status, payload] = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { ok: status < 400, status, json: async () => payload };
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    for (const [k, v] of Object.entries(saved))
      if (v == null) delete process.env[k];
      else process.env[k] = v;
  }
}

const ok = [200, { choices: [{ message: { content: "Bonjour" } }] }];
const overloaded = [503, [{ error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded." } }]];

test("an overloaded provider is retried once on the fallback model", async () => {
  await withProvider({ AI_FALLBACK_MODEL: "backup" }, [overloaded, ok], async (calls) => {
    assert.equal(await callAi({ system: "s", user: "u", timeoutMs: 8000 }), "Bonjour");
    assert.deepEqual(calls.map((c) => c.model), ["primary", "backup"]);
  });
});

test("without a fallback model the same model is retried once", async () => {
  await withProvider({}, [[429, { error: { code: "rate_limit_exceeded" } }], ok], async (calls) => {
    assert.equal(await callAi({ system: "s", user: "u", timeoutMs: 8000 }), "Bonjour");
    assert.deepEqual(calls.map((c) => c.model), ["primary", "primary"]);
  });
});

test("configuration errors are not retried", async () => {
  await withProvider({ AI_FALLBACK_MODEL: "backup", AI_REASONING_EFFORT: "none" }, [[400, [{ error: { code: 400, status: "INVALID_ARGUMENT" } }]], ok], async (calls) => {
    await assert.rejects(() => callAi({ system: "s", user: "u", timeoutMs: 8000 }), /indisponible/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reasoning_effort, "none");
  });
});

test("a lasting outage fails after two attempts with the usual message", async () => {
  await withProvider({ AI_FALLBACK_MODEL: "backup" }, [overloaded, overloaded], async (calls) => {
    await assert.rejects(() => callAi({ system: "s", user: "u", json: true, timeoutMs: 8000 }), /Le service IA est indisponible/);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].response_format, { type: "json_object" });
  });
});
