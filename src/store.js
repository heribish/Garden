import crypto from "node:crypto";
import pg from "pg";
import { canTransition, transitionOrder } from "./orderMachine.js";

/** @typedef {'mpesa' | 'airtel_money' | 'tigo_pesa' | 'halopesa'} WalletProvider */
/** @typedef {'cod' | WalletProvider} PaymentMethod */

const vendors = new Map();
const categories = new Map();
const products = new Map();
const orders = new Map();
const payments = new Map();
const paymentEvents = new Set();
const idempotency = new Map();
/** @type {{ id: string, vendor_id: string, order_id: string | null, type: string, amount_tzs: number, created_at: string, meta?: object }[]} */
const ledger = [];
const payouts = new Map();
const vendorApplications = [];
const refundRequests = [];
/** @type {Map<string, number>} category_id -> fee bps override */
const commissionByCategoryBps = new Map();

const LOW_STOCK_DEFAULT = 5;
const PLATFORM_FEE_BPS = 800;
let commerceDbPool = null;
let commerceDbReady = false;

function hasCommerceDb() {
  return Boolean(process.env.DATABASE_URL);
}

async function ensureCommerceDb() {
  if (!hasCommerceDb()) return null;
  if (commerceDbReady && commerceDbPool) return commerceDbPool;
  if (!commerceDbPool) {
    commerceDbPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
    });
  }
  await commerceDbPool.query(`
    create table if not exists commerce_webhook_events (
      event_id text primary key,
      created_at timestamptz not null default now()
    );
  `);
  await commerceDbPool.query(`
    create table if not exists commerce_payment_idempotency (
      idem_key text primary key,
      payment_id text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists commerce_payment_idempotency_created_at_idx
      on commerce_payment_idempotency(created_at);
  `);
  commerceDbReady = true;
  return commerceDbPool;
}

function iso(d) {
  return d.toISOString();
}

function startOfUtcDay(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function money(n) {
  if (!Number.isFinite(n)) throw new Error("Invalid amount");
  return Math.round(n);
}

function seed() {
  vendors.set("v1", {
    id: "v1",
    name: "Jiko Fresh Market",
    zone: "Central",
    pickup_label: "Jiko Fresh Market, Dar es Salaam",
    pickup_lat: -6.7924,
    pickup_lng: 39.2083,
    shop_phone: "255755000001",
    shop_open: true,
    rating_avg: 4.7,
    rating_count: 128,
    low_stock_threshold: LOW_STOCK_DEFAULT,
    platform_fee_bps: PLATFORM_FEE_BPS,
    currency: "TZS",
    country: "TZ",
    next_payout_date: "2026-04-28",
  });

  const cats = [
    { id: "c1", vendor_id: "v1", name: "Groceries", slug: "groceries" },
    { id: "c2", vendor_id: "v1", name: "Household", slug: "household" },
  ];
  for (const c of cats) categories.set(c.id, c);

  const items = [
    {
      id: "p1",
      vendor_id: "v1",
      category_id: "c1",
      name: "Sunflower Oil 1L",
      description: "1 litre cooking oil",
      price_tzs: 8500,
      stock_qty: 40,
      active: true,
      image_url: null,
    },
    {
      id: "p2",
      vendor_id: "v1",
      category_id: "c1",
      name: "Rice 5kg",
      description: "Premium rice",
      price_tzs: 22000,
      stock_qty: 3,
      active: true,
      image_url: null,
    },
    {
      id: "p3",
      vendor_id: "v1",
      category_id: "c2",
      name: "Soap (pack)",
      description: "Laundry soap multipack",
      price_tzs: 3500,
      stock_qty: 80,
      active: true,
      image_url: null,
    },
  ];
  for (const p of items) products.set(p.id, p);

  seedDemoHistory("v1");
  vendorApplications.push({
    id: "va_1",
    business_name: "Kinondoni Fruits Hub",
    contact_phone: "255788001100",
    zone: "Kinondoni",
    status: "pending",
    created_at: iso(new Date()),
  });
  vendorApplications.push({
    id: "va_2",
    business_name: "Ubungo Bakers",
    contact_phone: "255765004400",
    zone: "Ubungo",
    status: "pending",
    created_at: iso(new Date()),
  });
}

function seedDemoHistory(vendorId) {
  const now = new Date();
  for (let day = 6; day >= 0; day--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - day);
    const count = 2 + (day % 4);
    for (let i = 0; i < count; i++) {
      const id = `ord_seed_${vendorId}_${day}_${i}`;
      const total = money(15000 + ((day + i) % 5) * 2500);
      const created_at = iso(d);
      orders.set(id, {
        id,
        vendor_id: vendorId,
        country: "TZ",
        currency: "TZS",
        customer_phone: "2557*********",
        customer_name: "Walk-in customer",
        customer_city: "Dar es Salaam",
        delivery_area: "Kinondoni",
        payment_method: "cod",
        total_tzs: total,
        status: "delivered",
        lines: [{ product_id: "p1", name: "Sunflower Oil 1L", qty: 1, unit_price_tzs: 8500, line_total_tzs: 8500 }],
        created_at,
        updated_at: created_at,
        payment_id: null,
        dropoff_lat: -6.805 + (i % 3) * 0.004,
        dropoff_lng: 39.22 + (day % 3) * 0.004,
        dropoff_label: "Customer address (seed)",
        delivery_job_id: null,
        delivery_otp: null,
      });
      appendLedgerSale(vendorId, id, total, created_at);
    }
  }
}

export function appendLedgerSale(vendorId, orderId, gross_tzs, created_at) {
  const v = vendors.get(vendorId);
  const bps = v?.platform_fee_bps ?? PLATFORM_FEE_BPS;
  const fee = money((gross_tzs * bps) / 10000);
  const net = money(gross_tzs - fee);
  ledger.push({
    id: `led_${crypto.randomBytes(6).toString("hex")}`,
    vendor_id: vendorId,
    order_id: orderId,
    type: "sale",
    gross_tzs,
    fee_tzs: fee,
    net_tzs: net,
    created_at,
  });
}

seed();

export function getVendor(id) {
  return vendors.get(id);
}

export function setVendorShopOpen(vendorId, shop_open) {
  const v = vendors.get(vendorId);
  if (!v) return null;
  v.shop_open = Boolean(shop_open);
  v.updated_at = iso(new Date());
  return v;
}

export function updateVendorProfile(vendorId, patch) {
  const v = vendors.get(vendorId);
  if (!v) return null;
  if (patch.name != null) v.name = String(patch.name).trim() || v.name;
  if (patch.zone != null) v.zone = String(patch.zone).trim() || v.zone;
  if (patch.pickup_label != null) v.pickup_label = String(patch.pickup_label).trim() || v.pickup_label;
  if (patch.shop_phone != null) v.shop_phone = String(patch.shop_phone).replace(/\D/g, "") || v.shop_phone;
  if (patch.shop_open != null) {
    if (v.admin_paused && Boolean(patch.shop_open)) {
      throw new Error("Vendor is paused by admin");
    }
    v.shop_open = Boolean(patch.shop_open);
  }
  v.updated_at = iso(new Date());
  return v;
}

export function listCategories(vendorId) {
  return [...categories.values()].filter((c) => c.vendor_id === vendorId);
}

export function createCategory(vendorId, { name, slug }) {
  if (!vendors.get(vendorId)) throw new Error("Vendor not found");
  const id = `cat_${crypto.randomBytes(4).toString("hex")}`;
  const c = {
    id,
    vendor_id: vendorId,
    name: String(name || "").trim() || "Category",
    slug: String(slug || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-") || id,
  };
  categories.set(id, c);
  return c;
}

export function listVendorProducts(vendorId, { include_inactive } = {}) {
  return [...products.values()].filter((p) => p.vendor_id === vendorId && (include_inactive || p.active));
}

export function listPublicProducts(vendorId) {
  const v = vendors.get(vendorId);
  if (!v || !v.shop_open) return [];
  return [...products.values()].filter((p) => p.vendor_id === vendorId && p.active && p.stock_qty > 0);
}

export function listProducts() {
  return [...products.values()].filter((p) => {
    const v = vendors.get(p.vendor_id);
    return v?.shop_open && p.active && p.stock_qty > 0;
  });
}

export function getProduct(id) {
  return products.get(id);
}

export function createProduct(vendorId, input) {
  if (!vendors.get(vendorId)) throw new Error("Vendor not found");
  const id = `p_${crypto.randomBytes(5).toString("hex")}`;
  const p = {
    id,
    vendor_id: vendorId,
    category_id: input.category_id || null,
    name: String(input.name || "").trim() || "Product",
    description: String(input.description || "").trim(),
    price_tzs: money(Number(input.price_tzs)),
    stock_qty: Math.max(0, Math.floor(Number(input.stock_qty ?? 0))),
    active: input.active !== false,
    image_url: input.image_url ? String(input.image_url) : null,
    updated_at: iso(new Date()),
  };
  if (p.category_id && !categories.get(p.category_id)) throw new Error("Unknown category");
  products.set(id, p);
  return p;
}

export function updateProduct(vendorId, productId, patch) {
  const p = products.get(productId);
  if (!p || p.vendor_id !== vendorId) return null;
  if (patch.name != null) p.name = String(patch.name).trim() || p.name;
  if (patch.description != null) p.description = String(patch.description);
  if (patch.price_tzs != null) p.price_tzs = money(Number(patch.price_tzs));
  if (patch.stock_qty != null) p.stock_qty = Math.max(0, Math.floor(Number(patch.stock_qty)));
  if (patch.active != null) p.active = Boolean(patch.active);
  if (patch.category_id !== undefined) {
    if (patch.category_id && !categories.get(patch.category_id)) throw new Error("Unknown category");
    p.category_id = patch.category_id;
  }
  if (patch.image_url !== undefined) p.image_url = patch.image_url ? String(patch.image_url) : null;
  p.updated_at = iso(new Date());
  return p;
}

export function bulkUpdatePrices(vendorId, updates) {
  const out = [];
  for (const u of updates || []) {
    const p = products.get(u.product_id);
    if (!p || p.vendor_id !== vendorId) continue;
    if (u.price_tzs == null) continue;
    p.price_tzs = money(Number(u.price_tzs));
    p.updated_at = iso(new Date());
    out.push({ id: p.id, price_tzs: p.price_tzs });
  }
  return out;
}

export function normalizeMsisdnTz(msisdn) {
  const digits = String(msisdn).replace(/\D/g, "");
  if (digits.startsWith("255") && digits.length === 12) return digits;
  if (digits.length === 9 && digits.startsWith("7")) return `255${digits}`;
  if (digits.length === 10 && digits.startsWith("07")) return `255${digits.slice(1)}`;
  throw new Error("Invalid Tanzania MSISDN");
}

/**
 * @param {{ customer_phone: string, customer_name?: string, dropoff_label: string, customer_city?: string, delivery_area?: string, items: { product_id: string, qty: number }[], payment_method: PaymentMethod, vendor_id: string, dropoff_lat?: number, dropoff_lng?: number, customer_user_id?: string | null }} input
 */
export function createOrder(input) {
  const vendor = vendors.get(input.vendor_id);
  if (!vendor) throw new Error("Vendor not found");
  if (!vendor.shop_open) throw new Error("Shop is closed");

  const id = `ord_${crypto.randomBytes(6).toString("hex")}`;
  let total = 0;
  const lines = [];
  for (const line of input.items) {
    const p = products.get(line.product_id);
    if (!p) throw new Error(`Unknown product: ${line.product_id}`);
    if (p.vendor_id !== input.vendor_id) throw new Error("Product does not belong to vendor");
    if (!p.active) throw new Error(`Inactive product: ${p.name}`);
    const qty = Math.floor(line.qty);
    if (qty < 1) throw new Error("Invalid qty");
    if (p.stock_qty < qty) throw new Error(`Insufficient stock for ${p.name}`);
    const line_total = money(p.price_tzs * qty);
    total += line_total;
    lines.push({
      product_id: p.id,
      name: p.name,
      qty,
      unit_price_tzs: p.price_tzs,
      line_total_tzs: line_total,
    });
  }

  const v = vendors.get(input.vendor_id);
  const dropLat = input.dropoff_lat != null ? Number(input.dropoff_lat) : (v?.pickup_lat ?? -6.8) - 0.02 + Math.random() * 0.01;
  const dropLng = input.dropoff_lng != null ? Number(input.dropoff_lng) : (v?.pickup_lng ?? 39.21) + 0.02 + Math.random() * 0.01;

  const order = {
    id,
    vendor_id: input.vendor_id,
    country: "TZ",
    currency: "TZS",
    customer_phone: input.customer_phone,
    customer_name: String(input.customer_name || "Customer").trim() || "Customer",
    customer_city: String(input.customer_city || "Dar es Salaam").trim() || "Dar es Salaam",
    delivery_area: input.delivery_area ? String(input.delivery_area).trim() : null,
    payment_method: input.payment_method,
    customer_user_id: input.customer_user_id || null,
    total_tzs: money(total),
    status: "placed",
    lines,
    created_at: iso(new Date()),
    payment_id: null,
    dropoff_lat: dropLat,
    dropoff_lng: dropLng,
    dropoff_label: String(input.dropoff_label || "").trim() || "Customer drop-off",
    delivery_job_id: null,
    delivery_otp: null,
  };

  if (input.payment_method === "cod") {
    order.status = "new";
  }

  orders.set(id, order);
  return order;
}

export function getOrder(id) {
  return orders.get(id);
}

export function getAllOrders() {
  return [...orders.values()];
}

export function listVendorOrders(vendorId, { scope } = {}) {
  const all = [...orders.values()].filter((o) => o.vendor_id === vendorId);
  const activeStates = new Set([
    "new",
    "preparing",
    "ready_for_pickup",
    "driver_en_route_pickup",
    "driver_en_route_delivery",
    "placed",
    "payment_pending",
    "paid",
  ]);
  if (scope === "active") return all.filter((o) => activeStates.has(o.status)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (scope === "history") return all.filter((o) => !activeStates.has(o.status)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function acceptOrder(vendorId, orderId) {
  const o = orders.get(orderId);
  if (!o || o.vendor_id !== vendorId) throw new Error("Order not found");
  if (o.status !== "new") throw new Error("Order is not incoming");

  for (const line of o.lines) {
    const p = products.get(line.product_id);
    if (!p) throw new Error("Product missing");
    if (p.stock_qty < line.qty) throw new Error(`Insufficient stock for ${p.name}`);
  }
  for (const line of o.lines) {
    const p = products.get(line.product_id);
    p.stock_qty -= line.qty;
    p.updated_at = iso(new Date());
  }
  transitionOrder(o, "preparing");
  return o;
}

export function declineOrder(vendorId, orderId) {
  const o = orders.get(orderId);
  if (!o || o.vendor_id !== vendorId) throw new Error("Order not found");
  transitionOrder(o, "declined");
  return o;
}

export function advanceVendorOrder(vendorId, orderId, to) {
  const o = orders.get(orderId);
  if (!o || o.vendor_id !== vendorId) throw new Error("Order not found");
  if (to !== "ready_for_pickup") {
    throw new Error("Vendors only mark orders ready for pickup; delivery is completed in the driver app.");
  }
  if (o.status !== "preparing") {
    throw new Error(`Order must be preparing (currently ${o.status})`);
  }
  transitionOrder(o, "ready_for_pickup");
  o.dispatch_ready_at = iso(new Date());
  return o;
}

/**
 * @param {{ order_id: string, provider: WalletProvider, msisdn: string, idempotency_key?: string }} input
 */
export async function createWalletPaymentIntent(input) {
  const order = orders.get(input.order_id);
  if (!order) throw new Error("Order not found");
  if (order.payment_method !== input.provider) {
    throw new Error("Order payment method does not match provider");
  }
  if (order.status !== "placed" && order.status !== "payment_pending") {
    throw new Error(`Order not payable in state: ${order.status}`);
  }

  const idem = input.idempotency_key;
  const pool = await ensureCommerceDb();
  if (idem) {
    if (pool) {
      const existing = await pool.query(`select payment_id from commerce_payment_idempotency where idem_key = $1 limit 1`, [
        `pay:${idem}`,
      ]);
      const existingPaymentId = existing.rows[0]?.payment_id;
      if (existingPaymentId) {
        const pay = payments.get(existingPaymentId);
        if (!pay) throw new Error("Idempotency collision");
        return pay;
      }
    }
    const existingKey = idempotency.get(`pay:${idem}`);
    if (existingKey) {
      const pay = payments.get(existingKey);
      if (!pay) throw new Error("Idempotency collision");
      return pay;
    }
  }

  if (order.status === "payment_pending" && order.payment_id) {
    const existing = payments.get(order.payment_id);
    if (existing && existing.provider === input.provider) {
      return existing;
    }
  }

  const payment_id = `pay_${crypto.randomBytes(8).toString("hex")}`;
  const pay = {
    id: payment_id,
    order_id: order.id,
    provider: input.provider,
    msisdn: normalizeMsisdnTz(input.msisdn),
    amount_tzs: order.total_tzs,
    currency: "TZS",
    status: "pending",
    created_at: iso(new Date()),
    provider_reference: null,
  };
  payments.set(payment_id, pay);
  order.payment_id = payment_id;

  if (idem) {
    const idemKey = `pay:${idem}`;
    idempotency.set(idemKey, payment_id);
    if (pool) {
      await pool.query(
        `insert into commerce_payment_idempotency (idem_key, payment_id) values ($1, $2) on conflict (idem_key) do nothing`,
        [idemKey, payment_id]
      );
    }
  }
  return pay;
}

export function getPayment(id) {
  return payments.get(id);
}

export function updatePayment(id, patch) {
  const p = payments.get(id);
  if (!p) return null;
  Object.assign(p, patch);
  return p;
}

export async function appendPaymentEventUnique(eventId) {
  const pool = await ensureCommerceDb();
  if (pool) {
    const out = await pool.query(
      `insert into commerce_webhook_events (event_id) values ($1) on conflict (event_id) do nothing returning event_id`,
      [eventId]
    );
    return out.rowCount > 0;
  }
  if (paymentEvents.has(eventId)) return false;
  paymentEvents.add(eventId);
  return true;
}

export function getVendorDashboard(vendorId) {
  const v = vendors.get(vendorId);
  if (!v) return null;
  const now = new Date();
  const todayStart = startOfUtcDay(now);

  const vendorOrders = [...orders.values()].filter((o) => o.vendor_id === vendorId);
  const orders_today = vendorOrders.filter((o) => new Date(o.created_at) >= todayStart).length;

  const vendorLedger = ledger.filter((l) => l.vendor_id === vendorId && l.type === "sale");
  let revenue_today = 0;
  for (const row of vendorLedger) {
    if (new Date(row.created_at) >= todayStart) revenue_today += row.gross_tzs;
  }

  const pending = vendorOrders.filter((o) =>
    ["new", "preparing", "ready_for_pickup", "driver_en_route_pickup", "driver_en_route_delivery"].includes(o.status)
  );

  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    d.setUTCHours(12, 0, 0, 0);
    const dayStart = startOfUtcDay(d);
    const next = new Date(dayStart);
    next.setUTCDate(next.getUTCDate() + 1);
    let total = 0;
    for (const row of vendorLedger) {
      const t = new Date(row.created_at);
      if (t >= dayStart && t < next) total += row.gross_tzs;
    }
    weekly.push({ date: dayStart.toISOString().slice(0, 10), label: dayStart.toLocaleDateString("en-GB", { weekday: "short" }), total_tzs: total });
  }

  const low = [...products.values()].filter(
    (p) => p.vendor_id === vendorId && p.active && p.stock_qty > 0 && p.stock_qty <= (v.low_stock_threshold ?? LOW_STOCK_DEFAULT)
  );

  return {
    vendor: {
      id: v.id,
      name: v.name,
      zone: v.zone || null,
      pickup_label: v.pickup_label || null,
      shop_phone: v.shop_phone || null,
      shop_open: v.shop_open,
      rating_avg: v.rating_avg,
      rating_count: v.rating_count,
      currency: v.currency,
      next_payout_date: v.next_payout_date,
    },
    stats: {
      orders_today,
      revenue_today_tzs: revenue_today,
      pending_orders: pending.length,
    },
    weekly_sales_tzs: weekly,
    low_stock_products: low.map((p) => ({
      id: p.id,
      name: p.name,
      stock_qty: p.stock_qty,
      threshold: v.low_stock_threshold ?? LOW_STOCK_DEFAULT,
    })),
  };
}

export function getVendorEarnings(vendorId) {
  const v = vendors.get(vendorId);
  if (!v) return null;
  const rows = ledger.filter((l) => l.vendor_id === vendorId);
  let gross = 0;
  let fees = 0;
  let net_from_sales = 0;
  let refunds = 0;
  let balance = 0;
  let paid_out = 0;
  for (const l of rows) {
    if (l.type === "sale") {
      gross += l.gross_tzs;
      fees += l.fee_tzs;
      net_from_sales += l.net_tzs;
      balance += l.net_tzs;
    }
    if (l.type === "refund") {
      refunds += Math.abs(l.amount_tzs || 0);
      balance += l.amount_tzs || 0;
    }
    if (l.type === "payout") {
      const a = l.amount_tzs || 0;
      balance += a;
      paid_out += Math.abs(a);
    }
  }
  return {
    currency: v.currency,
    gross_sales_tzs: gross,
    platform_fees_tzs: fees,
    refunds_tzs: refunds,
    net_earnings_tzs: net_from_sales,
    paid_out_tzs: paid_out,
    available_balance_tzs: money(balance),
    next_payout_date: v.next_payout_date,
    payout_methods: [
      { id: "mpesa", label: "M-Pesa (business till)" },
      { id: "bank", label: "Bank transfer" },
      { id: "mobile_money", label: "Other mobile money" },
    ],
  };
}

export function requestPayout(vendorId, body) {
  const v = vendors.get(vendorId);
  if (!v) throw new Error("Vendor not found");
  const amount = money(Number(body.amount_tzs));
  if (amount <= 0) throw new Error("Invalid amount");
  const e = getVendorEarnings(vendorId);
  if (!e || e.available_balance_tzs < amount) throw new Error("Insufficient available balance");
  const id = `po_${crypto.randomBytes(5).toString("hex")}`;
  payouts.set(id, {
    id,
    vendor_id: vendorId,
    amount_tzs: amount,
    method: String(body.method || "mpesa"),
    destination: String(body.destination || ""),
    status: "pending",
    created_at: iso(new Date()),
  });
  ledger.push({
    id: `led_${crypto.randomBytes(6).toString("hex")}`,
    vendor_id: vendorId,
    order_id: null,
    type: "payout",
    amount_tzs: -amount,
    created_at: iso(new Date()),
  });
  return payouts.get(id);
}

export function ledgerStatementCsv(vendorId, month) {
  const v = vendors.get(vendorId);
  if (!v) return null;
  const m = String(month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error("month must be YYYY-MM");
  const [yy, mm] = m.split("-").map(Number);
  const start = new Date(Date.UTC(yy, mm - 1, 1));
  const end = new Date(Date.UTC(yy, mm, 1));
  const rows = ledger.filter((l) => {
    if (l.vendor_id !== vendorId) return false;
    const t = new Date(l.created_at);
    return t >= start && t < end;
  });
  const lines = ["date,type,order_id,gross_tzs,fee_tzs,net_tzs,amount_tzs,notes"];
  for (const l of rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    if (l.type === "sale") {
      lines.push(
        `${l.created_at},sale,${l.order_id},${l.gross_tzs},${l.fee_tzs},${l.net_tzs},,`
      );
    } else if (l.type === "payout") {
      lines.push(`${l.created_at},payout,,,,,${l.amount_tzs},`);
    } else if (l.type === "refund") {
      lines.push(`${l.created_at},refund,${l.order_id || ""},,,,${l.amount_tzs},`);
    }
  }
  return lines.join("\n");
}

export function addDemoRefund(vendorId, orderId, amount_tzs) {
  const amt = money(Number(amount_tzs));
  if (amt <= 0) throw new Error("refund amount must be positive");
  ledger.push({
    id: `led_${crypto.randomBytes(6).toString("hex")}`,
    vendor_id: vendorId,
    order_id,
    type: "refund",
    amount_tzs: -amt,
    created_at: iso(new Date()),
  });
  return true;
}

export function adminForceCancelOrder(o) {
  if (!o || ["delivered", "cancelled", "declined"].includes(o.status)) return o;
  if (canTransition(o.status, "cancelled")) {
    transitionOrder(o, "cancelled");
  } else {
    o.status = "cancelled";
    o.updated_at = iso(new Date());
  }
  return o;
}

export function getLedger() {
  return [...ledger];
}

export function listVendorApplications() {
  return [...vendorApplications];
}

export function createVendorApplication(input) {
  const business_name = String(input.business_name || "").trim();
  const contact_phone = String(input.contact_phone || "").replace(/\D/g, "");
  const zone = String(input.zone || "").trim();
  const contact_name = String(input.contact_name || "").trim() || null;
  const contact_email = input.contact_email ? String(input.contact_email).trim().toLowerCase() : null;
  const user_id = input.user_id ? String(input.user_id).trim() : null;
  if (!business_name || business_name.length < 2) throw new Error("business_name is required");
  if (!contact_phone || contact_phone.length < 8) throw new Error("contact_phone is required");
  if (!zone || zone.length < 2) throw new Error("zone is required");
  if (user_id) {
    const pending = vendorApplications.find((a) => a.user_id === user_id && a.status === "pending");
    if (pending) throw new Error("You already have a vendor application under review");
  }
  const id = `va_${crypto.randomBytes(4).toString("hex")}`;
  const app = {
    id,
    user_id,
    business_name,
    contact_phone,
    zone,
    contact_name,
    contact_email,
    status: "pending",
    created_at: iso(new Date()),
  };
  vendorApplications.push(app);
  return app;
}

export function approveVendorApplication(appId) {
  const app = vendorApplications.find((a) => a.id === appId);
  if (!app) throw new Error("Application not found");
  if (app.status !== "pending") throw new Error("Already processed");
  const vid = `v_${crypto.randomBytes(3).toString("hex")}`;
  vendors.set(vid, {
    id: vid,
    name: app.business_name,
    pickup_label: `${app.business_name} (${app.zone})`,
    pickup_lat: -6.79 + Math.random() * 0.04,
    pickup_lng: 39.2 + Math.random() * 0.06,
    shop_phone: app.contact_phone,
    shop_open: true,
    rating_avg: 0,
    rating_count: 0,
    low_stock_threshold: LOW_STOCK_DEFAULT,
    platform_fee_bps: PLATFORM_FEE_BPS,
    currency: "TZS",
    country: "TZ",
    next_payout_date: "2026-05-05",
    zone: app.zone,
    approved_from_application_id: app.id,
  });
  app.status = "approved";
  app.vendor_id = vid;
  app.processed_at = iso(new Date());
  return { vendor_id: vid, application: app };
}

export function rejectVendorApplication(appId) {
  const app = vendorApplications.find((a) => a.id === appId);
  if (!app) throw new Error("Application not found");
  app.status = "rejected";
  app.processed_at = iso(new Date());
  return app;
}

export function listRefundRequests() {
  return [...refundRequests];
}

export function createRefundRequest({ order_id, amount_tzs, reason }) {
  const o = orders.get(order_id);
  if (!o) throw new Error("Order not found");
  const id = `rfr_${crypto.randomBytes(4).toString("hex")}`;
  const r = {
    id,
    order_id,
    vendor_id: o.vendor_id,
    amount_tzs: money(Number(amount_tzs)),
    reason: String(reason || "").slice(0, 500),
    status: "pending",
    created_at: iso(new Date()),
  };
  refundRequests.push(r);
  return r;
}

export function setRefundRequestStatus(id, status) {
  const r = refundRequests.find((x) => x.id === id);
  if (!r) throw new Error("Refund request not found");
  if (r.status !== "pending") throw new Error("Refund request already processed");
  if (!["approved", "rejected"].includes(status)) throw new Error("Invalid status");
  r.status = status;
  r.processed_at = iso(new Date());
  if (status === "approved") {
    addDemoRefund(r.vendor_id, r.order_id, r.amount_tzs);
    const o = orders.get(r.order_id);
    if (o && !["delivered", "cancelled", "declined"].includes(o.status)) {
      adminForceCancelOrder(o);
    }
  }
  return r;
}

export function getCommissionSettings() {
  return {
    default_platform_fee_bps: PLATFORM_FEE_BPS,
    per_category_bps: Object.fromEntries(commissionByCategoryBps),
  };
}

export function setCommissionForCategory(categoryId, bps) {
  if (!categories.get(categoryId)) throw new Error("Unknown category");
  const b = Math.max(0, Math.min(5000, Math.round(Number(bps))));
  commissionByCategoryBps.set(categoryId, b);
  return { category_id: categoryId, platform_fee_bps: b };
}

export function getVendorPayoutHistory(vendorId) {
  return ledger.filter((l) => l.vendor_id === vendorId && l.type === "payout");
}

export function listAllVendors() {
  return [...vendors.values()];
}

export function countVendorProducts(vendorId) {
  return [...products.values()].filter((p) => p.vendor_id === vendorId && p.active).length;
}

export function adminPauseVendor(vendorId, paused) {
  const v = vendors.get(vendorId);
  if (!v) throw new Error("Vendor not found");
  v.shop_open = !paused;
  v.admin_paused = Boolean(paused);
  v.updated_at = iso(new Date());
  return v;
}

/** @type {Map<string, { id: string, type: string, order_id?: string, provider?: string, amount_tzs?: number, customer_name?: string, created_at: string, read: boolean }[]>} */
const vendorNotifications = new Map();

const WALLET_PROVIDER_LABELS = {
  mpesa: "M-Pesa",
  airtel_money: "Airtel Money",
  tigo_pesa: "Tigo Pesa",
  halopesa: "HaloPesa",
};

export function walletProviderLabel(provider) {
  return WALLET_PROVIDER_LABELS[provider] || String(provider || "Mobile money");
}

export function pushVendorNotification(vendorId, notification) {
  if (!vendorId) return null;
  const list = vendorNotifications.get(vendorId) || [];
  if (
    notification.type === "payment_received" &&
    notification.order_id &&
    list.some((n) => n.type === "payment_received" && n.order_id === notification.order_id)
  ) {
    return null;
  }
  const row = {
    id: notification.id || `vn_${crypto.randomBytes(5).toString("hex")}`,
    type: notification.type,
    order_id: notification.order_id || null,
    provider: notification.provider || null,
    amount_tzs: notification.amount_tzs ?? null,
    customer_name: notification.customer_name || null,
    created_at: notification.created_at || iso(new Date()),
    read: false,
  };
  list.unshift(row);
  if (list.length > 80) list.length = 80;
  vendorNotifications.set(vendorId, list);
  return row;
}

export function listVendorNotifications(vendorId, { unreadOnly = false } = {}) {
  const list = vendorNotifications.get(vendorId) || [];
  const rows = unreadOnly ? list.filter((n) => !n.read) : [...list];
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function ackVendorNotifications(vendorId, ids) {
  const list = vendorNotifications.get(vendorId) || [];
  const want = new Set((ids || []).map(String));
  let acked = 0;
  for (const n of list) {
    if (want.has(n.id) && !n.read) {
      n.read = true;
      acked += 1;
    }
  }
  return { acked };
}

/** Notify vendor when a wallet webhook confirms payment (order becomes actionable). */
export function notifyVendorPaymentReceived(order, payment) {
  if (!order?.vendor_id || !payment) return null;
  return pushVendorNotification(order.vendor_id, {
    type: "payment_received",
    order_id: order.id,
    provider: payment.provider,
    amount_tzs: payment.amount_tzs,
    customer_name: order.customer_name,
  });
}
