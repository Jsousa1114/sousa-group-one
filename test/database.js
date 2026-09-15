const { PGlite } = require("@electric-sql/pglite");
// PGlite runs real PostgreSQL in WASM. This adapter serializes connections like a pool of size 1.
async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  let tail = Promise.resolve();
  async function acquire() {
    let release;
    const before = tail;
    tail = new Promise((r) => (release = r));
    await before;
    return release;
  }
  return {
    async query(sql, params) {
      const unlock = await acquire();
      try {
        return await pg.query(sql, params);
      } finally {
        unlock();
      }
    },
    async connect() {
      const unlock = await acquire();
      return { query: (s, p) => pg.query(s, p), release: unlock };
    },
    end: () => pg.close(),
  };
}
module.exports = { database };
