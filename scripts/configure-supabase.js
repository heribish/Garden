/**
 * Interactive Supabase setup (no PowerShell parsing issues).
 *
 *   node scripts/configure-supabase.js
 *
 * Paste the full postgresql:// URI from Supabase (password replaced).
 * Writes .env, tests connection, migrates, creates admin heribish@gmail.com.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");

function askHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const onData = (char) => {
      const s = String(char);
      if (s === "\n" || s === "\r" || s === "\u0004") return;
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      process.stdout.write(question + "*".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} exited with code ${code}`));
    });
  });
}

function upsertEnv(databaseUrl) {
  let text = "";
  if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, "utf8");
  else if (fs.existsSync(path.join(root, ".env.example"))) {
    text = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  }

  const lines = text.split(/\r?\n/);
  const out = [];
  let seenDb = false;
  let seenSsl = false;
  for (const line of lines) {
    if (/^\s*DATABASE_URL=/.test(line)) {
      if (seenDb) continue;
      seenDb = true;
      out.push(`DATABASE_URL=${databaseUrl}`);
      continue;
    }
    if (/^\s*PGSSL=/.test(line)) {
      if (seenSsl) continue;
      seenSsl = true;
      out.push("PGSSL=1");
      continue;
    }
    out.push(line);
  }
  if (!seenDb) out.push(`DATABASE_URL=${databaseUrl}`);
  if (!seenSsl) out.push("PGSSL=1");
  fs.writeFileSync(envPath, out.join("\n").replace(/\n+$/, "\n"), "utf8");
}

function randomPassword(len = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

console.log("");
console.log("Garden - Supabase configuration");
console.log("================================");
console.log("1. Open https://supabase.com/dashboard and sign in.");
console.log("2. Open your project (or create a new one named garden).");
console.log("3. Project Settings > Database > Reset database password.");
console.log("4. Copy Connection string > URI (Session pooler preferred).");
console.log("5. Replace [YOUR-PASSWORD] in that URI with the new password.");
console.log("");
console.log("Paste the FULL postgresql://... connection string below.");
console.log("");

const databaseUrl = await askHidden("DATABASE_URL: ");
if (!databaseUrl) {
  console.error("Cancelled - no URL entered.");
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  console.error("That does not look like a PostgreSQL URI. Cancelled.");
  process.exit(1);
}
if (/YOUR_PASSWORD|REPLACE_ME|\[YOUR-PASSWORD\]/i.test(databaseUrl)) {
  console.error("Replace the password placeholder in the URI first, then re-run.");
  process.exit(1);
}

upsertEnv(databaseUrl);
process.env.DATABASE_URL = databaseUrl;
process.env.PGSSL = "1";
console.log("");
console.log("Wrote DATABASE_URL and PGSSL=1 to .env (password not printed).");

console.log("Testing database connection...");
try {
  await runNode(path.join(__dirname, "test-db-connection.js"));
} catch {
  console.error("");
  console.error("Connection failed. Common fixes:");
  console.error("  - Reset the database password in Supabase and paste a fresh URI");
  console.error("  - Try Session pooler URI if Direct fails (or the reverse)");
  console.error("  - Confirm the project is not paused");
  console.error("  - URL-encode special password characters: @ as %40 , ! as %21");
  process.exit(1);
}

console.log("Running migrations...");
await runNode(path.join(__dirname, "migrate-commerce.js"));

const adminPass = randomPassword(20);
console.log("Ensuring admin account heribish@gmail.com ...");
await runNode(path.join(__dirname, "create-admin.js"), {
  ADMIN_EMAIL: "heribish@gmail.com",
  ADMIN_PASSWORD: adminPass,
  ADMIN_NAME: "Heribish",
});

console.log("");
console.log("Done.");
console.log("  Admin email: heribish@gmail.com");
console.log("  Temporary admin password (save now): " + adminPass);
console.log("  Sign in at /shop, then open /admin");
console.log("  Change this password after first login.");
console.log("");
