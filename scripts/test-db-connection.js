/**
 * Quick DATABASE_URL connectivity check.
 * Usage: DATABASE_URL=... PGSSL=1 node scripts/test-db-connection.js
 */
import pg from "pg";
import { loadEnvFile } from "./load-env.js";

loadEnvFile();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("CONNECTION_FAILED DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
});

try {
  const r = await pool.query("select current_database() as db, now() as ts");
  console.log("CONNECTED", r.rows[0].db, String(r.rows[0].ts));
  process.exitCode = 0;
} catch (e) {
  console.error("CONNECTION_FAILED", e.code || "", e.message || e);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
