import crypto from "node:crypto";
import readline from "node:readline";
import pg from "pg";
import { loadEnvFile } from "./load-env.js";

loadEnvFile();

/**
 * Provision (or update) an admin account in the configured Postgres database.
 *
 * Usage:
 *   node scripts/create-admin.js --email you@example.com --password "secret" --name "Your Name"
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret node scripts/create-admin.js
 *
 * If the email already exists, the account is promoted to admin and its
 * password is reset to the value you provide. Safe to re-run.
 */

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const key = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${key}`;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "true";
      out[key] = val;
    }
  }
  return out;
}

function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (silent) {
      const onData = (char) => {
        const s = String(char);
        if (s === "\n" || s === "\r" || s === "\u0004") return;
        process.stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
      };
      process.stdin.on("data", onData);
      rl.question(question, (answer) => {
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set in .env — cannot create a persistent admin.");
    console.error("Set your Supabase Session pooler URL in .env, then re-run this script.");
    process.exit(1);
  }

  let email = (args.email || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  let password = args.password || process.env.ADMIN_PASSWORD || "";
  const name = (args.name || process.env.ADMIN_NAME || "Admin").trim() || "Admin";

  if (!email) email = (await ask("Admin email: ")).trim().toLowerCase();
  if (!password) password = await ask("Admin password (min 8 chars): ", { silent: true });

  if (!email || !email.includes("@")) {
    console.error("A valid admin email is required.");
    process.exit(1);
  }
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await pool.query(`
      create table if not exists auth_users (
        id text primary key,
        role text not null,
        name text not null,
        phone text unique,
        email text unique,
        locale text not null default 'en',
        vendor_id text,
        driver_id text,
        password_hash text not null,
        created_at timestamptz not null default now()
      );
    `);
    await pool.query(`alter table auth_users add column if not exists driver_verification_status text default 'none';`);

    const existing = await pool.query(`select id, role from auth_users where email = $1 limit 1`, [email]);
    const password_hash = hashPassword(password);

    if (existing.rowCount > 0) {
      const id = existing.rows[0].id;
      await pool.query(`update auth_users set role = 'admin', name = $2, password_hash = $3 where id = $1`, [
        id,
        name,
        password_hash,
      ]);
      console.log(`\nUpdated existing account to ADMIN and reset its password.`);
      console.log(`  email: ${email}`);
      console.log(`  id:    ${id}`);
    } else {
      const id = randomId("usr");
      await pool.query(
        `insert into auth_users (id, role, name, email, locale, password_hash, driver_verification_status, created_at)
         values ($1,'admin',$2,$3,'en',$4,'none', now())`,
        [id, name, email, password_hash]
      );
      console.log(`\nCreated new ADMIN account.`);
      console.log(`  email: ${email}`);
      console.log(`  id:    ${id}`);
    }
    console.log(`\nSign in at /shop (use the email + password above), then open /admin.`);
  } catch (e) {
    console.error("Failed to create admin:", e.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
