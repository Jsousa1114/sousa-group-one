"use strict";
const { pool, migrate } = require("../db");
const { migrateLegacyFiles, available } = require("../storage");

(async () => {
  if (!available())
    throw new Error("Configure OBJECT_STORAGE_* variables before migration.");
  await migrate(pool);
  const result = await migrateLegacyFiles(pool, {
    deleteDatabaseCopy: process.argv.includes("--delete-db"),
  });
  console.log(JSON.stringify(result));
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
