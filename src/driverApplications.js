import crypto from "node:crypto";
import pg from "pg";

const memory = [];

let dbPool = null;
let dbReady = false;

function hasDb() {
  return Boolean(process.env.DATABASE_URL);
}

function iso(d = new Date()) {
  return d.toISOString();
}

async function ensureDb() {
  if (!hasDb()) return null;
  if (dbReady && dbPool) return dbPool;
  dbPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
  });
  await dbPool.query(`
    create table if not exists commerce_driver_applications (
      id text primary key,
      user_id text not null,
      status text not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      reviewed_at timestamptz
    );
    create index if not exists commerce_driver_applications_user_idx on commerce_driver_applications(user_id);
    create index if not exists commerce_driver_applications_status_idx on commerce_driver_applications(status);
  `);
  dbReady = true;
  return dbPool;
}

function sortApps(rows) {
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function rowToApp(row) {
  const payload = row.payload || {};
  return {
    ...payload,
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    reviewed_at: row.reviewed_at
      ? row.reviewed_at instanceof Date
        ? row.reviewed_at.toISOString()
        : row.reviewed_at
      : payload.reviewed_at || null,
  };
}

async function insertApp(app) {
  const pool = await ensureDb();
  if (!pool) {
    memory.push(app);
    return app;
  }
  await pool.query(
    `insert into commerce_driver_applications (id, user_id, status, payload, created_at, reviewed_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [app.id, app.user_id, app.status, app, app.created_at, app.reviewed_at]
  );
  return app;
}

async function updateApp(app) {
  const pool = await ensureDb();
  if (!pool) {
    const i = memory.findIndex((a) => a.id === app.id);
    if (i >= 0) memory[i] = app;
    return app;
  }
  await pool.query(
    `update commerce_driver_applications set status = $2, payload = $3, reviewed_at = $4 where id = $1`,
    [app.id, app.status, app, app.reviewed_at]
  );
  return app;
}

async function loadAll() {
  const pool = await ensureDb();
  if (!pool) return [...memory];
  const r = await pool.query(
    `select id, user_id, status, payload, created_at, reviewed_at from commerce_driver_applications`
  );
  return r.rows.map(rowToApp);
}

export async function listDriverApplications({ status } = {}) {
  let rows = await loadAll();
  if (status) rows = rows.filter((a) => a.status === status);
  return sortApps(rows);
}

export async function getDriverApplicationById(appId) {
  const rows = await loadAll();
  return rows.find((a) => a.id === appId) || null;
}

export async function getDriverApplicationForUser(userId) {
  const rows = await loadAll();
  return (
    rows.find((a) => a.user_id === userId && a.status === "pending") ||
    sortApps(rows.filter((a) => a.user_id === userId))[0] ||
    null
  );
}

export async function createDriverApplicationRecord(app) {
  return insertApp(app);
}

export async function saveDriverApplicationRecord(app) {
  return updateApp(app);
}

export function newDriverApplicationId() {
  return `da_${crypto.randomBytes(4).toString("hex")}`;
}
