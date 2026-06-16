import crypto from "node:crypto";
import pg from "pg";

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 12);
const users = new Map();
const sessions = new Map();
let dbPool = null;
let dbReady = false;
let dbDisabled = false;

function hasDb() {
  return Boolean(process.env.DATABASE_URL) && !dbDisabled;
}

async function ensureDb() {
  if (!hasDb()) return null;
  if (dbReady && dbPool) return dbPool;
  if (!dbPool) {
    dbPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
    });
  }
  try {
    await dbPool.query(`
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
    await dbPool.query(`
      alter table auth_users add column if not exists driver_verification_status text default 'none';
    `);
    await dbPool.query(`
      create table if not exists auth_sessions (
        id text primary key,
        user_id text not null references auth_users(id) on delete cascade,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      );
      create index if not exists auth_sessions_user_id_idx on auth_sessions(user_id);
      create index if not exists auth_sessions_expires_at_idx on auth_sessions(expires_at);
    `);
    dbReady = true;
    return dbPool;
  } catch (e) {
    dbDisabled = true;
    dbPool = null;
    dbReady = false;
    const msg = String(e?.message || e || "unknown");
    const dev = process.env.NODE_ENV !== "production";
    const unreachable = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg);
    if (process.env.DATABASE_URL && dev && unreachable) {
      // eslint-disable-next-line no-console
      console.warn(`[garden] Postgres unavailable (${msg}) — using in-memory auth for development.`);
      return null;
    }
    if (process.env.DATABASE_URL) {
      throw new Error(`DATABASE_URL configured but auth DB init failed: ${msg}`);
    }
    return null;
  }
}

function nowMs() {
  return Date.now();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function normalizePhone(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const key = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${key}`;
}

function verifyPassword(storedHash, providedPassword) {
  const [salt, keyHex] = String(storedHash || "").split(":");
  if (!salt || !keyHex) return false;
  const provided = crypto.scryptSync(String(providedPassword), salt, 64).toString("hex");
  const a = Buffer.from(keyHex, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function driverVerificationStatus(user) {
  if (!user) return "none";
  if (user.driver_verification_status) return user.driver_verification_status;
  if (user.driver_id) return "verified";
  return "none";
}

function publicCapabilities(user) {
  if (!user) return null;
  const dStatus = driverVerificationStatus(user);
  return {
    shopper: true,
    vendor: user.vendor_id
      ? { status: "active", vendor_id: user.vendor_id }
      : { status: "none", vendor_id: null },
    driver: {
      status: dStatus,
      driver_id: dStatus === "verified" ? user.driver_id || null : null,
    },
    admin: user.role === "admin",
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    phone: user.phone || null,
    email: user.email || null,
    locale: user.locale || "en",
    vendor_id: user.vendor_id || null,
    driver_id: user.driver_id || null,
    driver_verification_status: driverVerificationStatus(user),
    capabilities: publicCapabilities(user),
    created_at: user.created_at,
  };
}

export function getUserRecord(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return users.get(id) || null;
}

export async function getUserRecordAsync(userId) {
  const mem = getUserRecord(userId);
  if (mem) return mem;
  const pool = await ensureDb();
  if (!pool) return null;
  const r = await pool.query(
    `select id, role, name, phone, email, locale, vendor_id, driver_id, driver_verification_status, password_hash, created_at from auth_users where id = $1 limit 1`,
    [userId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    ...row,
    driver_verification_status: row.driver_verification_status || (row.driver_id ? "verified" : "none"),
  };
}

export async function setUserDriverState(userId, { driver_id, driver_verification_status }) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("Invalid user id");
  const pool = await ensureDb();
  if (pool) {
    const existingRes = await pool.query(
      `select id, role, name, phone, email, locale, vendor_id, driver_id, driver_verification_status, created_at from auth_users where id = $1`,
      [id]
    );
    const existing = existingRes.rows[0];
    if (!existing) throw new Error("User not found");
    const nextDriverId = driver_id !== undefined ? driver_id || null : existing.driver_id;
    const nextStatus =
      driver_verification_status !== undefined ? driver_verification_status : existing.driver_verification_status || "none";
    let nextRole = existing.role;
    if (nextStatus === "verified" && existing.role !== "admin") nextRole = "driver";
    if (nextStatus === "rejected" && existing.role === "driver" && !existing.vendor_id) nextRole = "shopper";
    await pool.query(
      `update auth_users set driver_id = $2, driver_verification_status = $3, role = $4 where id = $1`,
      [id, nextDriverId, nextStatus, nextRole]
    );
    return publicUser({
      ...existing,
      driver_id: nextDriverId,
      driver_verification_status: nextStatus,
      role: nextRole,
    });
  }
  const u = users.get(id);
  if (!u) throw new Error("User not found");
  if (driver_id !== undefined) u.driver_id = driver_id || null;
  if (driver_verification_status !== undefined) {
    u.driver_verification_status = driver_verification_status;
    if (driver_verification_status === "verified" && u.role !== "admin") u.role = "driver";
    if (driver_verification_status === "rejected" && u.role === "driver" && !u.vendor_id) u.role = "shopper";
  }
  users.set(id, u);
  return publicUser(u);
}

export async function setUserVendorId(userId, vendorId) {
  const id = String(userId || "").trim();
  const vid = String(vendorId || "").trim() || null;
  if (!id) throw new Error("Invalid user id");
  const pool = await ensureDb();
  if (pool) {
    await pool.query(`update auth_users set vendor_id = $2, role = case when role = 'admin' then role else 'vendor' end where id = $1`, [
      id,
      vid,
    ]);
    const r = await pool.query(
      `select id, role, name, phone, email, locale, vendor_id, driver_id, created_at from auth_users where id = $1`,
      [id]
    );
    return publicUser({ ...r.rows[0], driver_verification_status: r.rows[0].driver_id ? "verified" : "none" });
  }
  const u = users.get(id);
  if (!u) throw new Error("User not found");
  u.vendor_id = vid;
  if (u.role !== "admin") u.role = vid ? "vendor" : "shopper";
  users.set(id, u);
  return publicUser(u);
}

export function userHasVendorAccess(user) {
  return Boolean(user?.vendor_id);
}

export function userHasVerifiedDriverAccess(user) {
  if (!user?.driver_id) return false;
  const s = driverVerificationStatus(user);
  return s === "verified";
}

export function userIsAdmin(user) {
  return user?.role === "admin";
}

function parseRole(role) {
  const r = String(role || "shopper");
  const allowed = new Set(["shopper", "vendor", "driver", "admin"]);
  if (!allowed.has(r)) throw new Error("Invalid role");
  return r;
}

function assertUniqueIdentity({ phone, email }) {
  for (const u of users.values()) {
    if (phone && u.phone === phone) throw new Error("Phone already in use");
    if (email && u.email === email) throw new Error("Email already in use");
  }
}

function assertUniqueIdentityForUpdate(userId, { phone, email }) {
  for (const u of users.values()) {
    if (u.id === userId) continue;
    if (phone && u.phone === phone) throw new Error("Phone already in use");
    if (email && u.email === email) throw new Error("Email already in use");
  }
}

export async function createUser(input) {
  const role = parseRole(input.role);
  const password = String(input.password || "");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (!phone && !email) throw new Error("phone or email required");
  const pool = await ensureDb();
  if (!pool) {
    assertUniqueIdentity({ phone: phone || null, email: email || null });
  }
  const vendor_id = String(input.vendor_id || "").trim() || null;
  const driver_id = String(input.driver_id || "").trim() || null;
  const driver_verification_status =
    input.driver_verification_status ||
    (driver_id ? "verified" : "none");

  const user = {
    id: randomId("usr"),
    role,
    name: String(input.name || "User").trim() || "User",
    phone: phone || null,
    email: email || null,
    locale: String(input.locale || "en"),
    vendor_id,
    driver_id,
    driver_verification_status,
    password_hash: hashPassword(password),
    created_at: new Date().toISOString(),
  };
  if (pool) {
    try {
      await pool.query(
        `
          insert into auth_users (id, role, name, phone, email, locale, vendor_id, driver_id, password_hash, created_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          user.id,
          user.role,
          user.name,
          user.phone,
          user.email,
          user.locale,
          user.vendor_id,
          user.driver_id,
          user.password_hash,
          user.created_at,
        ]
      );
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("auth_users_phone_key") || msg.includes("auth_users_email_key")) {
        throw new Error("Phone or email already in use");
      }
      throw e;
    }
  } else {
    users.set(user.id, user);
  }
  return publicUser(user);
}

export async function updateUserProfile(userId, patch) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("Invalid user id");
  const nextName = patch.name != null ? String(patch.name).trim() : undefined;
  const nextPhone = patch.phone !== undefined ? normalizePhone(patch.phone) : undefined;
  const nextEmail = patch.email !== undefined ? normalizeEmail(patch.email) : undefined;
  const nextLocale = patch.locale != null ? String(patch.locale).trim() : undefined;
  const pool = await ensureDb();
  if (pool) {
    const existingRes = await pool.query(
      `select id, role, name, phone, email, locale, vendor_id, driver_id, created_at from auth_users where id = $1 limit 1`,
      [id]
    );
    const existing = existingRes.rows[0];
    if (!existing) throw new Error("User not found");
    const updated = {
      ...existing,
      name: nextName !== undefined ? (nextName || existing.name) : existing.name,
      phone: nextPhone !== undefined ? nextPhone || null : existing.phone,
      email: nextEmail !== undefined ? nextEmail || null : existing.email,
      locale: nextLocale !== undefined ? (nextLocale || existing.locale || "en") : existing.locale,
    };
    if (!updated.phone && !updated.email) throw new Error("phone or email required");
    try {
      await pool.query(
        `update auth_users set name = $2, phone = $3, email = $4, locale = $5 where id = $1`,
        [id, updated.name, updated.phone, updated.email, updated.locale]
      );
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("auth_users_phone_key") || msg.includes("auth_users_email_key")) {
        throw new Error("Phone or email already in use");
      }
      throw e;
    }
    return publicUser(updated);
  }
  const existing = users.get(id);
  if (!existing) throw new Error("User not found");
  const updated = {
    ...existing,
    name: nextName !== undefined ? nextName || existing.name : existing.name,
    phone: nextPhone !== undefined ? nextPhone || null : existing.phone,
    email: nextEmail !== undefined ? nextEmail || null : existing.email,
    locale: nextLocale !== undefined ? nextLocale || existing.locale || "en" : existing.locale,
  };
  if (!updated.phone && !updated.email) throw new Error("phone or email required");
  assertUniqueIdentityForUpdate(id, { phone: updated.phone, email: updated.email });
  users.set(id, updated);
  return publicUser(updated);
}

export async function changeUserPassword(userId, currentPassword, newPassword) {
  const id = String(userId || "").trim();
  const current = String(currentPassword || "");
  const next = String(newPassword || "");
  if (!id) throw new Error("Invalid user id");
  if (next.length < 8) throw new Error("New password must be at least 8 characters");
  const pool = await ensureDb();
  if (pool) {
    const row = await pool.query(`select id, password_hash from auth_users where id = $1 limit 1`, [id]);
    const existing = row.rows[0];
    if (!existing) throw new Error("User not found");
    if (!verifyPassword(existing.password_hash, current)) throw new Error("Current password is incorrect");
    await pool.query(`update auth_users set password_hash = $2 where id = $1`, [id, hashPassword(next)]);
    return { ok: true };
  }
  const existing = users.get(id);
  if (!existing) throw new Error("User not found");
  if (!verifyPassword(existing.password_hash, current)) throw new Error("Current password is incorrect");
  existing.password_hash = hashPassword(next);
  users.set(id, existing);
  return { ok: true };
}

export async function authenticateUser({ phone, email, password }) {
  const phoneN = normalizePhone(phone);
  const emailN = normalizeEmail(email);
  if (!phoneN && !emailN) throw new Error("phone or email required");
  const pool = await ensureDb();
  let u = null;
  if (pool) {
    const r = await pool.query(
      `
        select id, role, name, phone, email, locale, vendor_id, driver_id, password_hash, created_at
        from auth_users
        where ($1 <> '' and phone = $1) or ($2 <> '' and email = $2)
        limit 1
      `,
      [phoneN, emailN]
    );
    u = r.rows[0] || null;
  } else {
    u = [...users.values()].find((x) => (phoneN ? x.phone === phoneN : false) || (emailN ? x.email === emailN : false));
  }
  if (!u) return null;
  if (!verifyPassword(u.password_hash, String(password || ""))) return null;
  return publicUser(u);
}

export async function createSession(userId) {
  const sid = randomId("ses");
  const row = {
    id: sid,
    user_id: userId,
    created_at: new Date().toISOString(),
    expires_at: new Date(nowMs() + SESSION_TTL_MS).toISOString(),
  };
  const pool = await ensureDb();
  if (pool) {
    await pool.query(
      `insert into auth_sessions (id, user_id, created_at, expires_at) values ($1,$2,$3,$4)`,
      [row.id, row.user_id, row.created_at, row.expires_at]
    );
  } else {
    sessions.set(sid, row);
  }
  return sid;
}

export async function deleteSession(sessionId) {
  const pool = await ensureDb();
  if (pool) {
    await pool.query(`delete from auth_sessions where id = $1`, [String(sessionId || "")]);
  } else {
    sessions.delete(sessionId);
  }
}

export async function getUserBySession(sessionId) {
  const sid = String(sessionId || "");
  if (!sid) return null;
  const pool = await ensureDb();
  if (pool) {
    const r = await pool.query(
      `
        select s.id, s.user_id, s.expires_at, u.id as uid, u.role, u.name, u.phone, u.email, u.locale, u.vendor_id, u.driver_id, u.driver_verification_status, u.created_at
        from auth_sessions s
        join auth_users u on u.id = s.user_id
        where s.id = $1
        limit 1
      `,
      [sid]
    );
    const row = r.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= nowMs()) {
      await pool.query(`delete from auth_sessions where id = $1`, [sid]);
      return null;
    }
    return publicUser({
      id: row.uid,
      role: row.role,
      name: row.name,
      phone: row.phone,
      email: row.email,
      locale: row.locale,
      vendor_id: row.vendor_id,
      driver_id: row.driver_id,
      driver_verification_status: row.driver_verification_status,
      created_at: row.created_at,
    });
  }
  const s = sessions.get(sid);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() <= nowMs()) {
    sessions.delete(s.id);
    return null;
  }
  const u = users.get(s.user_id);
  return publicUser(u || null);
}

export async function seedAuthUsers() {
  const pool = await ensureDb();
  if (pool) {
    const check = await pool.query(`select id from auth_users limit 1`);
    if (check.rowCount > 0) return;
  } else if (users.size > 0) {
    return;
  }
  await createUser({
    name: "Demo Shopper",
    role: "shopper",
    phone: "255744000111",
    password: "shop1234",
    locale: "en",
  });
  await createUser({
    name: "Vendor v1",
    role: "vendor",
    email: "vendor@garden.local",
    password: "vendor1234",
    vendor_id: "v1",
    locale: "en",
  });
  await createUser({
    name: "Driver d1",
    role: "driver",
    email: "driver@garden.local",
    password: "driver1234",
    driver_id: "d1",
    driver_verification_status: "verified",
    locale: "en",
  });
  await createUser({
    name: "Admin",
    role: "admin",
    email: "admin@garden.local",
    password: "admin1234",
    locale: "en",
  });
}
