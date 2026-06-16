import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnvFile, projectRoot } from "./load-env.js";

loadEnvFile();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, "../db/migrations");

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Copy .env.example to .env and set DATABASE_URL, " +
        "or start local Postgres: docker compose up -d db"
    );
  }
  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));
    for (const f of files) {
      const sql = await fs.readFile(path.join(migrationsDir, f), "utf8");
      await pool.query(sql);
      // eslint-disable-next-line no-console
      console.log(`Applied migration: ${f}`);
    }
    // eslint-disable-next-line no-console
    console.log("Commerce migrations complete.");
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", err.message || err);
  process.exit(1);
});
