import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Customer-support messaging.
 * Persists to Postgres when DATABASE_URL works, otherwise to .data/support-dev.json
 * so chats survive restarts during private-beta testing.
 */

/** @type {Map<string, object>} */
const conversations = new Map();
/** @type {Map<string, object[]>} */
const messagesByConversation = new Map();
/** @type {Map<string, string>} */
const conversationByUser = new Map();

const MAX_BODY = 2000;
const DEV_STORE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".data", "support-dev.json");
const persistEnabled = process.env.NODE_ENV !== "test";

let dbPool = null;
let dbReady = false;
let dbDisabled = false;

function iso(d = new Date()) {
  return d.toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

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
      create table if not exists commerce_support_conversations (
        id text primary key,
        user_id text not null unique,
        status text not null,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      );
    `);
    await dbPool.query(`
      create table if not exists commerce_support_messages (
        id text primary key,
        conversation_id text not null references commerce_support_conversations(id) on delete cascade,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
    `);
    dbReady = true;
    return dbPool;
  } catch (e) {
    dbDisabled = true;
    dbPool = null;
    dbReady = false;
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(`[garden] Support DB unavailable (${e.message || e}) — using local support store.`);
    }
    return null;
  }
}

function loadDevStore() {
  if (!persistEnabled) return;
  try {
    const raw = fs.readFileSync(DEV_STORE_PATH, "utf8");
    const data = JSON.parse(raw);
    conversations.clear();
    messagesByConversation.clear();
    conversationByUser.clear();
    for (const c of data.conversations || []) {
      conversations.set(c.id, c);
      conversationByUser.set(c.user_id, c.id);
    }
    for (const [cid, msgs] of Object.entries(data.messages || {})) {
      messagesByConversation.set(cid, msgs);
    }
  } catch {
    // first run
  }
}

function saveDevStore() {
  if (!persistEnabled) return;
  try {
    fs.mkdirSync(path.dirname(DEV_STORE_PATH), { recursive: true });
    const messages = {};
    for (const [cid, list] of messagesByConversation.entries()) messages[cid] = list;
    fs.writeFileSync(
      DEV_STORE_PATH,
      JSON.stringify(
        {
          conversations: [...conversations.values()],
          messages,
        },
        null,
        2
      )
    );
  } catch {
    // best effort
  }
}

loadDevStore();

function publicConversation(c) {
  if (!c) return null;
  return {
    id: c.id,
    user_id: c.user_id,
    user_name: c.user_name,
    user_phone: c.user_phone,
    user_email: c.user_email,
    status: c.status,
    created_at: c.created_at,
    updated_at: c.updated_at,
    last_message_at: c.last_message_at,
    last_message_preview: c.last_message_preview,
    unread_for_admin: c.unread_for_admin,
    unread_for_user: c.unread_for_user,
  };
}

async function persistConversation(c) {
  saveDevStore();
  const pool = await ensureDb();
  if (!pool) return;
  await pool.query(
    `insert into commerce_support_conversations (id, user_id, status, payload, updated_at)
     values ($1,$2,$3,$4,$5)
     on conflict (id) do update set user_id = excluded.user_id, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
    [c.id, c.user_id, c.status, JSON.stringify(c), c.updated_at]
  );
}

async function persistMessage(msg) {
  saveDevStore();
  const pool = await ensureDb();
  if (!pool) return;
  await pool.query(
    `insert into commerce_support_messages (id, conversation_id, payload, created_at)
     values ($1,$2,$3,$4)
     on conflict (id) do update set payload = excluded.payload`,
    [msg.id, msg.conversation_id, JSON.stringify(msg), msg.created_at]
  );
}

async function hydrateFromDb() {
  const pool = await ensureDb();
  if (!pool) return;
  const convs = await pool.query(`select payload from commerce_support_conversations`);
  const msgs = await pool.query(`select payload from commerce_support_messages order by created_at asc`);
  if (!convs.rowCount && !msgs.rowCount) return;
  conversations.clear();
  messagesByConversation.clear();
  conversationByUser.clear();
  for (const row of convs.rows) {
    const c = row.payload;
    conversations.set(c.id, c);
    conversationByUser.set(c.user_id, c.id);
    if (!messagesByConversation.has(c.id)) messagesByConversation.set(c.id, []);
  }
  for (const row of msgs.rows) {
    const m = row.payload;
    const list = messagesByConversation.get(m.conversation_id) || [];
    list.push(m);
    messagesByConversation.set(m.conversation_id, list);
  }
  saveDevStore();
}

const hydrateReady = hydrateFromDb().catch(() => {});

export function getOrCreateConversationForUser(user) {
  if (!user?.id) throw new Error("Authentication required");
  const existingId = conversationByUser.get(user.id);
  if (existingId && conversations.has(existingId)) {
    const c = conversations.get(existingId);
    c.user_name = user.name || c.user_name;
    c.user_phone = user.phone || c.user_phone;
    c.user_email = user.email || c.user_email;
    void persistConversation(c);
    return c;
  }
  const id = newId("sup");
  const now = iso();
  const c = {
    id,
    user_id: user.id,
    user_name: user.name || "Customer",
    user_phone: user.phone || null,
    user_email: user.email || null,
    status: "open",
    created_at: now,
    updated_at: now,
    last_message_at: null,
    last_message_preview: null,
    unread_for_admin: 0,
    unread_for_user: 0,
  };
  conversations.set(id, c);
  conversationByUser.set(user.id, id);
  messagesByConversation.set(id, []);
  const welcome = appendMessageSync(id, {
    sender_role: "system",
    sender_name: "Garden Support",
    body: "Karibu! Habari, welcome to Garden support. Tell us what you need help with and our team will reply here.",
  });
  c.unread_for_user = 0;
  void persistConversation(c);
  void persistMessage(welcome);
  return c;
}

function appendMessageSync(conversationId, { sender_role, sender_name, body }) {
  const c = conversations.get(conversationId);
  if (!c) throw new Error("Conversation not found");
  const text = String(body || "").trim().slice(0, MAX_BODY);
  if (!text) throw new Error("Message body is required");
  const msg = {
    id: newId("msg"),
    conversation_id: conversationId,
    sender_role,
    sender_name: sender_name || (sender_role === "admin" ? "Garden Support" : "Customer"),
    body: text,
    created_at: iso(),
    deleted_for_user: false,
  };
  const list = messagesByConversation.get(conversationId) || [];
  list.push(msg);
  messagesByConversation.set(conversationId, list);
  c.updated_at = msg.created_at;
  c.last_message_at = msg.created_at;
  c.last_message_preview = text.slice(0, 120);
  if (sender_role === "user") c.unread_for_admin += 1;
  if (sender_role === "admin") c.unread_for_user += 1;
  // system welcome does not bump unread
  return msg;
}

export function postUserMessage(user, body) {
  const c = getOrCreateConversationForUser(user);
  if (c.status === "closed") c.status = "open";
  const msg = appendMessageSync(c.id, {
    sender_role: "user",
    sender_name: user.name || "Customer",
    body,
  });
  void persistConversation(c);
  void persistMessage(msg);
  return msg;
}

export function postAdminMessage(conversationId, admin, body) {
  const c = conversations.get(conversationId);
  if (!c) throw new Error("Conversation not found");
  if (c.status === "closed") c.status = "open";
  const msg = appendMessageSync(conversationId, {
    sender_role: "admin",
    sender_name: admin?.name || "Garden Support",
    body,
  });
  void persistConversation(c);
  void persistMessage(msg);
  return msg;
}

/** Soft-delete on the user's side only — message remains for admin history. */
export function deleteUserMessage(user, messageId) {
  if (!user?.id) throw new Error("Authentication required");
  const cid = conversationByUser.get(user.id);
  if (!cid) throw new Error("Conversation not found");
  const list = messagesByConversation.get(cid) || [];
  const msg = list.find((m) => m.id === messageId);
  if (!msg) throw new Error("Message not found");
  if (msg.sender_role !== "user") throw new Error("You can only delete your own messages");
  msg.deleted_for_user = true;
  void persistMessage(msg);
  saveDevStore();
  return { ok: true, id: msg.id };
}

export function listMessages(conversationId, { forUser = false } = {}) {
  const list = [...(messagesByConversation.get(conversationId) || [])];
  if (forUser) return list.filter((m) => !m.deleted_for_user);
  return list;
}

export function getUserThread(user) {
  // Ensure any async hydrate finished for this request path in production.
  const c = getOrCreateConversationForUser(user);
  return {
    conversation: publicConversation(c),
    messages: listMessages(c.id, { forUser: true }),
  };
}

export function markReadForUser(user) {
  const id = conversationByUser.get(user.id);
  if (!id) return;
  const c = conversations.get(id);
  if (c) {
    c.unread_for_user = 0;
    void persistConversation(c);
  }
}

export function markReadForAdmin(conversationId) {
  const c = conversations.get(conversationId);
  if (c) {
    c.unread_for_admin = 0;
    void persistConversation(c);
  }
}

export function listConversationsForAdmin() {
  return [...conversations.values()]
    .map(publicConversation)
    .sort((a, b) => (String(a.last_message_at || a.created_at) < String(b.last_message_at || b.created_at) ? 1 : -1));
}

export function getConversationForAdmin(conversationId) {
  const c = conversations.get(conversationId);
  if (!c) return null;
  return { conversation: publicConversation(c), messages: listMessages(conversationId, { forUser: false }) };
}

export function setConversationStatus(conversationId, status) {
  const c = conversations.get(conversationId);
  if (!c) throw new Error("Conversation not found");
  if (!["open", "closed"].includes(status)) throw new Error("Invalid status");
  c.status = status;
  c.updated_at = iso();
  void persistConversation(c);
  return publicConversation(c);
}

export function adminUnreadTotal() {
  let total = 0;
  for (const c of conversations.values()) total += c.unread_for_admin || 0;
  return total;
}

export async function ready() {
  await hydrateReady;
}
