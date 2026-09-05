import crypto from "node:crypto";
import pg from "pg";
import { canTransition, transitionOrder } from "./orderMachine.js";
import { calculateDeliveryFare, fareClassFromVehicleType } from "./fare.js";
import {
  VENDOR_PLATFORM_FEE_BPS,
  customerPriceFromVendor,
  platformFeeFromCustomerGross,
  vendorPriceFromCustomer,
} from "./fees.js";

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
/** @type {Map<string, object>} payment_request_id -> request (admin asks vendor to settle, e.g. end of shift) */
const paymentRequests = new Map();
const vendorApplications = [];
const refundRequests = [];
/** @type {Map<string, number>} category_id -> fee bps override */
const commissionByCategoryBps = new Map();

const LOW_STOCK_DEFAULT = 5;
const PLATFORM_FEE_BPS = VENDOR_PLATFORM_FEE_BPS;
let commerceDbPool = null;
let commerceDbReady = false;
let commerceDbDisabled = false;

function hasCommerceDb() {
  return Boolean(process.env.DATABASE_URL) && !commerceDbDisabled;
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
  try {
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
  } catch (e) {
    // Same policy as auth: in development an unreachable DB must not block orders/payments.
    commerceDbDisabled = true;
    commerceDbPool = null;
    commerceDbReady = false;
    const msg = String(e?.message || e || "unknown");
    if (process.env.NODE_ENV === "production") {
      throw new Error(`DATABASE_URL configured but commerce DB init failed: ${msg}`);
    }
    // eslint-disable-next-line no-console
    console.warn(`[garden] Commerce DB unavailable (${msg}) — using in-memory payment idempotency for development.`);
    return null;
  }
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

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** City hubs used to match customers to nearby shops. */
const CITY_HUBS = {
  dar: { city_id: "dar", city: "Dar es Salaam", lat: -6.7924, lng: 39.2083 },
  arusha: { city_id: "arusha", city: "Arusha", lat: -3.3869, lng: 36.683 },
  mwanza: { city_id: "mwanza", city: "Mwanza", lat: -2.5164, lng: 32.9175 },
  dodoma: { city_id: "dodoma", city: "Dodoma", lat: -6.163, lng: 35.7516 },
  mbeya: { city_id: "mbeya", city: "Mbeya", lat: -8.9094, lng: 33.4608 },
  zanzibar: { city_id: "zanzibar", city: "Zanzibar", lat: -6.1659, lng: 39.2026 },
};

function normalizeCityKey(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!s) return null;
  if (CITY_HUBS[s]) return s;
  if (/dar\s*es\s*salaam|\bdar\b/.test(s)) return "dar";
  if (/arusha/.test(s)) return "arusha";
  if (/mwanza/.test(s)) return "mwanza";
  if (/dodoma/.test(s)) return "dodoma";
  if (/mbeya/.test(s)) return "mbeya";
  if (/zanzibar|unguja|stone\s*town/.test(s)) return "zanzibar";
  return null;
}

function seedCatalogForVendor(vendorId, { idPrefix, stockScale = 1 } = {}) {
  const gId = `${idPrefix}c1`;
  const hId = `${idPrefix}c2`;
  categories.set(gId, { id: gId, vendor_id: vendorId, name: "Groceries", slug: "groceries" });
  categories.set(hId, { id: hId, vendor_id: vendorId, name: "Household", slug: "household" });
  const items = [
    {
      id: `${idPrefix}p1`,
      vendor_id: vendorId,
      category_id: gId,
      name: "Sunflower Oil 1L",
      description: "1 litre cooking oil",
      brand: "Korie",
      unit: "bottle",
      price_tzs: 8500,
      stock_qty: Math.max(5, Math.round(40 * stockScale)),
      active: true,
      image_url: null,
      wholesale_enabled: true,
      wholesale_price_tzs: 7800,
      wholesale_min_qty: 12,
    },
    {
      id: `${idPrefix}p2`,
      vendor_id: vendorId,
      category_id: gId,
      name: "Rice 5kg",
      description: "Premium rice",
      brand: "Mbeya",
      unit: "bag",
      price_tzs: 22000,
      stock_qty: Math.max(2, Math.round(8 * stockScale)),
      active: true,
      image_url: null,
      wholesale_enabled: false,
      wholesale_price_tzs: 0,
      wholesale_min_qty: 0,
    },
    {
      id: `${idPrefix}p3`,
      vendor_id: vendorId,
      category_id: hId,
      name: "Soap (pack)",
      description: "Laundry soap multipack",
      brand: "Foma",
      unit: "pack",
      price_tzs: 3500,
      stock_qty: Math.max(10, Math.round(80 * stockScale)),
      active: true,
      image_url: null,
      wholesale_enabled: true,
      wholesale_price_tzs: 3000,
      wholesale_min_qty: 24,
    },
  ];
  for (const p of items) products.set(p.id, p);
  return items;
}

function seed() {
  const shopSeeds = [
    {
      id: "v1",
      name: "Jiko Fresh Market",
      city_id: "dar",
      zone: "Central",
      pickup_label: "Jiko Fresh Market, Dar es Salaam",
      pickup_lat: -6.7924,
      pickup_lng: 39.2083,
      shop_phone: "255755000001",
      rating_avg: 4.7,
      rating_count: 128,
      idPrefix: "",
      stockScale: 1,
      seedHistory: true,
    },
    {
      id: "v_arusha",
      name: "Arusha Market Hub",
      city_id: "arusha",
      zone: "Arusha CBD",
      pickup_label: "Arusha Market Hub, Sokoine Rd",
      pickup_lat: -3.3869,
      pickup_lng: 36.683,
      shop_phone: "255755000010",
      rating_avg: 4.5,
      rating_count: 64,
      idPrefix: "aru_",
      stockScale: 0.9,
    },
    {
      id: "v_mwanza",
      name: "Lake Zone Grocers",
      city_id: "mwanza",
      zone: "Nyamagana",
      pickup_label: "Lake Zone Grocers, Mwanza",
      pickup_lat: -2.5164,
      pickup_lng: 32.9175,
      shop_phone: "255755000020",
      rating_avg: 4.4,
      rating_count: 41,
      idPrefix: "mwz_",
      stockScale: 0.85,
    },
    {
      id: "v_dodoma",
      name: "Capital Fresh Store",
      city_id: "dodoma",
      zone: "Dodoma Central",
      pickup_label: "Capital Fresh Store, Dodoma",
      pickup_lat: -6.163,
      pickup_lng: 35.7516,
      shop_phone: "255755000030",
      rating_avg: 4.3,
      rating_count: 37,
      idPrefix: "dod_",
      stockScale: 0.8,
    },
    {
      id: "v_mbeya",
      name: "Mbeya Highlands Mart",
      city_id: "mbeya",
      zone: "Mbeya Urban",
      pickup_label: "Mbeya Highlands Mart",
      pickup_lat: -8.9094,
      pickup_lng: 33.4608,
      shop_phone: "255755000040",
      rating_avg: 4.6,
      rating_count: 52,
      idPrefix: "mby_",
      stockScale: 0.95,
    },
    {
      id: "v_zanzibar",
      name: "Stone Town Provisions",
      city_id: "zanzibar",
      zone: "Stone Town",
      pickup_label: "Stone Town Provisions, Zanzibar",
      pickup_lat: -6.1659,
      pickup_lng: 39.2026,
      shop_phone: "255755000050",
      rating_avg: 4.8,
      rating_count: 89,
      idPrefix: "znz_",
      stockScale: 0.75,
    },
  ];

  for (const s of shopSeeds) {
    const hub = CITY_HUBS[s.city_id];
    vendors.set(s.id, {
      id: s.id,
      name: s.name,
      city_id: s.city_id,
      city: hub.city,
      zone: s.zone,
      pickup_label: s.pickup_label,
      pickup_lat: s.pickup_lat,
      pickup_lng: s.pickup_lng,
      shop_phone: s.shop_phone,
      logo_url: null,
      shop_open: true,
      rating_avg: s.rating_avg,
      rating_count: s.rating_count,
      low_stock_threshold: LOW_STOCK_DEFAULT,
      platform_fee_bps: PLATFORM_FEE_BPS,
      currency: "TZS",
      country: "TZ",
      next_payout_date: "2026-04-28",
      settlement_method: "mpesa",
      settlement_number: s.shop_phone,
    });
    seedCatalogForVendor(s.id, { idPrefix: s.idPrefix, stockScale: s.stockScale });
    if (s.seedHistory) seedDemoHistory(s.id);
  }

  // Keep stable demo product ids for Dar (tests / docs still use p1–p3).
  // seedCatalogForVendor already created p1–p3 via empty idPrefix.

  vendorApplications.push({
    id: "va_1",
    business_name: "Kinondoni Fruits Hub",
    contact_phone: "255788001100",
    zone: "Kinondoni",
    city_id: "dar",
    status: "pending",
    created_at: iso(new Date()),
  });
  vendorApplications.push({
    id: "va_2",
    business_name: "Ubungo Bakers",
    contact_phone: "255765004400",
    zone: "Ubungo",
    city_id: "dar",
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
        subtotal_tzs: total,
        delivery_fare_tzs: 0,
        delivery_distance_km: 0,
        status: "delivered",
        lines: [
          {
            product_id: "p1",
            name: "Sunflower Oil 1L",
            qty: 1,
            unit_price_tzs: 8500,
            line_total_tzs: 8500,
            image_url: products.get("p1")?.image_url || null,
          },
        ],
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
  const fee = platformFeeFromCustomerGross(gross_tzs);
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
  if (patch.settlement_method != null) v.settlement_method = String(patch.settlement_method).trim() || v.settlement_method;
  if (patch.settlement_number != null) v.settlement_number = String(patch.settlement_number).trim();
  if (patch.logo_url !== undefined) {
    if (patch.logo_url === null || patch.logo_url === "") {
      v.logo_url = null;
    } else {
      const s = String(patch.logo_url);
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(s)) {
        throw new Error("Shop photo must be a JPEG, PNG, or WebP image");
      }
      if (s.length > 220000) throw new Error("Shop photo is too large — try a smaller image");
      v.logo_url = s;
    }
  }
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
  return [...products.values()]
    .filter((p) => p.vendor_id === vendorId && (include_inactive || p.active))
    .map((p) => withDerivedPricing({ ...p }));
}

export function listPublicProducts(vendorId) {
  const v = vendors.get(vendorId);
  if (!v || !v.shop_open) return [];
  return [...products.values()]
    .filter((p) => p.vendor_id === vendorId && p.active)
    .map((p) => toCustomerProduct(p));
}

export function listProducts() {
  return [...products.values()]
    .filter((p) => {
      const v = vendors.get(p.vendor_id);
      return v?.shop_open && p.active;
    })
    .map((p) => toCustomerProduct(p));
}

/**
 * Open shops near a customer city / GPS point.
 * Prefer same-city match; otherwise shops within radiusKm of the customer coords/city hub.
 */
export function listVendorsNear({ city, cityId, lat, lng, radiusKm = 90 } = {}) {
  const key = normalizeCityKey(cityId) || normalizeCityKey(city);
  const hub = key ? CITY_HUBS[key] : null;
  const originLat = Number.isFinite(Number(lat)) ? Number(lat) : hub?.lat;
  const originLng = Number.isFinite(Number(lng)) ? Number(lng) : hub?.lng;
  const radius = Math.max(5, Number(radiusKm) || 90);

  const rows = [];
  for (const v of vendors.values()) {
    if (!v.shop_open) continue;
    const sameCity = key && (v.city_id === key || normalizeCityKey(v.city) === key);
    let distance_km = null;
    if (Number.isFinite(originLat) && Number.isFinite(originLng) && Number.isFinite(v.pickup_lat) && Number.isFinite(v.pickup_lng)) {
      distance_km = Math.round(haversineKm(originLat, originLng, v.pickup_lat, v.pickup_lng) * 10) / 10;
    }
    const within = distance_km != null && distance_km <= radius;
    if (!sameCity && !within && key) continue;
    if (!key && !within) continue;
    rows.push({
      id: v.id,
      name: v.name,
      city: v.city || hub?.city || null,
      city_id: v.city_id || normalizeCityKey(v.city),
      zone: v.zone,
      pickup_label: v.pickup_label,
      pickup_lat: v.pickup_lat,
      pickup_lng: v.pickup_lng,
      distance_km,
      same_city: Boolean(sameCity),
      rating_avg: v.rating_avg,
    });
  }

  rows.sort((a, b) => {
    if (a.same_city !== b.same_city) return a.same_city ? -1 : 1;
    const da = a.distance_km ?? 9999;
    const db = b.distance_km ?? 9999;
    return da - db;
  });
  return rows;
}

/** Products from the nearest open shop for this customer city / GPS. */
export function listProductsNear(opts = {}) {
  const nearby = listVendorsNear(opts);
  const nearest = nearby[0] || null;
  if (!nearest) {
    return { vendors: [], vendor: null, products: [], city: opts.city || null, city_id: opts.cityId || null };
  }
  const productsNear = [...products.values()]
    .filter((p) => p.vendor_id === nearest.id && p.active)
    .map((p) =>
      toCustomerProduct({
        ...p,
        vendor_name: nearest.name,
        vendor_city: nearest.city,
        vendor_zone: nearest.zone,
        distance_km: nearest.distance_km,
      })
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    vendors: nearby,
    vendor: nearest,
    products: productsNear,
    city: nearest.city || opts.city || null,
    city_id: nearest.city_id || opts.cityId || null,
  };
}

export function getProduct(id) {
  return products.get(id);
}

/** Normalise wholesale/bulk-pricing fields from arbitrary input. */
function normalizeWholesale(input, fallback = {}) {
  const enabled = input.wholesale_enabled != null ? Boolean(input.wholesale_enabled) : Boolean(fallback.wholesale_enabled);
  let vendorWholesale =
    input.wholesale_vendor_price_tzs != null
      ? money(Number(input.wholesale_vendor_price_tzs) || 0)
      : input.wholesale_price_tzs != null
        ? vendorPriceFromCustomer(Number(input.wholesale_price_tzs) || 0)
        : fallback.wholesale_vendor_price_tzs ??
          (fallback.wholesale_price_tzs ? vendorPriceFromCustomer(fallback.wholesale_price_tzs) : 0);
  let price = customerPriceFromVendor(vendorWholesale);
  let minQty = input.wholesale_min_qty != null ? Math.max(0, Math.floor(Number(input.wholesale_min_qty) || 0)) : fallback.wholesale_min_qty ?? 0;
  if (!enabled) {
    return {
      wholesale_enabled: false,
      wholesale_vendor_price_tzs: vendorWholesale || 0,
      wholesale_price_tzs: price || 0,
      wholesale_min_qty: minQty || 0,
    };
  }
  if (minQty < 2) minQty = 2;
  return {
    wholesale_enabled: true,
    wholesale_vendor_price_tzs: vendorWholesale || 0,
    wholesale_price_tzs: price || 0,
    wholesale_min_qty: minQty,
  };
}

function resolveProductPricing(input, fallback = {}) {
  let vendor_price_tzs;
  let price_tzs;
  if (input.vendor_price_tzs != null) {
    vendor_price_tzs = money(Number(input.vendor_price_tzs));
    price_tzs = customerPriceFromVendor(vendor_price_tzs);
  } else if (input.price_tzs != null) {
    price_tzs = money(Number(input.price_tzs));
    vendor_price_tzs = vendorPriceFromCustomer(price_tzs);
  } else if (fallback.vendor_price_tzs != null || fallback.price_tzs != null) {
    vendor_price_tzs =
      fallback.vendor_price_tzs != null ? money(fallback.vendor_price_tzs) : vendorPriceFromCustomer(fallback.price_tzs);
    price_tzs =
      fallback.price_tzs != null ? money(fallback.price_tzs) : customerPriceFromVendor(vendor_price_tzs);
  } else {
    throw new Error("Price is required");
  }
  if (vendor_price_tzs < 0 || price_tzs < 0) throw new Error("Price must be zero or positive");
  return { vendor_price_tzs, price_tzs };
}

function withDerivedPricing(p) {
  if (p.vendor_price_tzs == null && p.price_tzs != null) {
    p.vendor_price_tzs = vendorPriceFromCustomer(p.price_tzs);
  }
  if (p.wholesale_enabled && p.wholesale_vendor_price_tzs == null && p.wholesale_price_tzs > 0) {
    p.wholesale_vendor_price_tzs = vendorPriceFromCustomer(p.wholesale_price_tzs);
  }
  return p;
}

/** Shop/catalog view: customer pays vendor base + 10% app fee. Strips internal vendor prices. */
export function toCustomerProduct(p) {
  if (!p) return null;
  const row = { ...p };
  if (row.vendor_price_tzs != null) {
    row.price_tzs = customerPriceFromVendor(row.vendor_price_tzs);
    if (row.wholesale_enabled && row.wholesale_vendor_price_tzs > 0) {
      row.wholesale_price_tzs = customerPriceFromVendor(row.wholesale_vendor_price_tzs);
    }
  }
  delete row.vendor_price_tzs;
  delete row.wholesale_vendor_price_tzs;
  return row;
}

function resolveStockQty(raw) {
  if (raw == null || raw === "") return 10;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 10;
  return Math.max(0, n);
}

export function createProduct(vendorId, input) {
  if (!vendors.get(vendorId)) throw new Error("Vendor not found");
  const { vendor_price_tzs, price_tzs } = resolveProductPricing(input);
  const id = `p_${crypto.randomBytes(5).toString("hex")}`;
  const p = {
    id,
    vendor_id: vendorId,
    category_id: input.category_id || null,
    name: String(input.name || "").trim() || "Product",
    description: String(input.description || "").trim(),
    brand: String(input.brand || "").trim() || null,
    unit: String(input.unit || "").trim() || null,
    size: String(input.size || "").trim() || null,
    vendor_price_tzs,
    price_tzs,
    stock_qty: resolveStockQty(input.stock_qty),
    active: input.active !== false,
    image_url: input.image_url ? String(input.image_url) : null,
    ...normalizeWholesale(input),
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
  if (patch.brand !== undefined) p.brand = String(patch.brand || "").trim() || null;
  if (patch.unit !== undefined) p.unit = String(patch.unit || "").trim() || null;
  if (patch.size !== undefined) p.size = String(patch.size || "").trim() || null;
  if (patch.vendor_price_tzs != null || patch.price_tzs != null) {
    Object.assign(p, resolveProductPricing(patch, p));
  }
  if (patch.stock_qty != null) p.stock_qty = resolveStockQty(patch.stock_qty);
  if (patch.active != null) p.active = Boolean(patch.active);
  if (patch.category_id !== undefined) {
    if (patch.category_id && !categories.get(patch.category_id)) throw new Error("Unknown category");
    p.category_id = patch.category_id;
  }
  if (patch.image_url !== undefined) p.image_url = patch.image_url ? String(patch.image_url) : null;
  if (
    patch.wholesale_enabled !== undefined ||
    patch.wholesale_price_tzs !== undefined ||
    patch.wholesale_min_qty !== undefined
  ) {
    Object.assign(p, normalizeWholesale(patch, p));
  }
  p.updated_at = iso(new Date());
  return p;
}

export function bulkUpdatePrices(vendorId, updates) {
  const out = [];
  for (const u of updates || []) {
    const p = products.get(u.product_id);
    if (!p || p.vendor_id !== vendorId) continue;
    if (u.vendor_price_tzs == null && u.price_tzs == null) continue;
    Object.assign(p, resolveProductPricing(u, p));
    p.updated_at = iso(new Date());
    out.push({ id: p.id, vendor_price_tzs: p.vendor_price_tzs, price_tzs: p.price_tzs });
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
    const priced = toCustomerProduct(p);
    const wholesale =
      priced.wholesale_enabled && priced.wholesale_price_tzs > 0 && priced.wholesale_min_qty > 0 && qty >= priced.wholesale_min_qty;
    const unit_price = wholesale ? priced.wholesale_price_tzs : priced.price_tzs;
    const line_total = money(unit_price * qty);
    total += line_total;
    lines.push({
      product_id: p.id,
      name: p.name,
      qty,
      unit_price_tzs: unit_price,
      line_total_tzs: line_total,
      wholesale_applied: wholesale,
      image_url: p.image_url || null,
      size: p.size || null,
      unit: p.unit || null,
    });
  }

  const v = vendors.get(input.vendor_id);
  const dropLat = input.dropoff_lat != null ? Number(input.dropoff_lat) : (v?.pickup_lat ?? -6.8) - 0.02 + Math.random() * 0.01;
  const dropLng = input.dropoff_lng != null ? Number(input.dropoff_lng) : (v?.pickup_lng ?? 39.21) + 0.02 + Math.random() * 0.01;

  const pickupLat = Number(v?.pickup_lat);
  const pickupLng = Number(v?.pickup_lng);
  const distance_km =
    Number.isFinite(pickupLat) && Number.isFinite(pickupLng) && Number.isFinite(dropLat) && Number.isFinite(dropLng)
      ? Math.round(haversineKm(pickupLat, pickupLng, dropLat, dropLng) * 100) / 100
      : 3;
  const vehicle_class = fareClassFromVehicleType(input.vehicle_class || "Boda Boda");
  const fare = calculateDeliveryFare({ distance_km, vehicle_class });
  const subtotal_tzs = money(total);
  const delivery_fare_tzs = money(fare.fare_tzs);
  const total_tzs = money(subtotal_tzs + delivery_fare_tzs);

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
    subtotal_tzs,
    delivery_fare_tzs,
    delivery_distance_km: fare.distance_km,
    delivery_eta_min: fare.eta_min,
    delivery_fare_basis: fare.basis,
    delivery_vehicle_class: fare.vehicle_class,
    delivery_fare_breakdown: fare.breakdown,
    total_tzs,
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

  if (input.payment_method === "cod" || input.payment_method === "bank") {
    // COD and bank transfer: vendor can start fulfilling; bank customers pay offline.
    order.status = "new";
  }

  orders.set(id, order);
  return order;
}

/** Preview LATRA-aligned delivery fare from a shop to customer coordinates. */
export function quoteDeliveryFare({ vendor_id, dropoff_lat, dropoff_lng, vehicle_class } = {}) {
  const v = vendors.get(String(vendor_id || "").trim());
  if (!v) throw new Error("Vendor not found");
  const dropLat = Number(dropoff_lat);
  const dropLng = Number(dropoff_lng);
  const pickupLat = Number(v.pickup_lat);
  const pickupLng = Number(v.pickup_lng);
  if (!Number.isFinite(dropLat) || !Number.isFinite(dropLng)) {
    throw new Error("Customer location is required for fare (use GPS or set city hub)");
  }
  if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
    throw new Error("Shop location is missing");
  }
  const distance_km = Math.round(haversineKm(pickupLat, pickupLng, dropLat, dropLng) * 100) / 100;
  const fare = calculateDeliveryFare({
    distance_km,
    vehicle_class: fareClassFromVehicleType(vehicle_class || "Boda Boda"),
  });
  return {
    vendor_id: v.id,
    shop_name: v.name,
    shop_label: v.pickup_label || v.name,
    pickup: { lat: pickupLat, lng: pickupLng },
    dropoff: { lat: dropLat, lng: dropLng },
    ...fare,
  };
}

export function getOrder(id) {
  return orders.get(id);
}

export function getAllOrders() {
  return [...orders.values()];
}

export function listVendorOrders(vendorId, { scope } = {}) {
  const all = [...orders.values()]
    .filter((o) => o.vendor_id === vendorId)
    .map((o) => enrichOrderLinesWithProductImages(o));
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

/** Attach product photos to order lines (snapshot or live catalog fallback). */
function enrichOrderLinesWithProductImages(order) {
  if (!order?.lines?.length) return order;
  const lines = order.lines.map((line) => {
    if (line.image_url) return line;
    const p = products.get(line.product_id);
    if (!p?.image_url) return line;
    return { ...line, image_url: p.image_url, size: line.size || p.size || null, unit: line.unit || p.unit || null };
  });
  return { ...order, lines };
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
      settlement_method: v.settlement_method || null,
      settlement_number: v.settlement_number || null,
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
    settlement_method: v.settlement_method || null,
    settlement_number: v.settlement_number || null,
    payout_methods: [
      { id: "mpesa", label: "M-Pesa (business till)" },
      { id: "bank", label: "Bank transfer" },
      { id: "mobile_money", label: "Other mobile money" },
    ],
  };
}

/* ---------------------------------------------------------------------------
 * Vendor settlement payment requests
 * The admin asks a vendor to pay the platform (e.g. commission collected in
 * cash) at the end of each shift. Vendors see and confirm these on their
 * account. In-memory, consistent with the rest of the MVP.
 * ------------------------------------------------------------------------- */

function publicPaymentRequest(r) {
  if (!r) return null;
  const v = vendors.get(r.vendor_id);
  return {
    id: r.id,
    vendor_id: r.vendor_id,
    vendor_name: v ? v.name : r.vendor_id,
    amount_tzs: r.amount_tzs,
    gross_sales_tzs: r.gross_sales_tzs ?? null,
    platform_fees_tzs: r.platform_fees_tzs ?? null,
    reason: r.reason,
    method: r.method,
    settlement_number: v ? v.settlement_number || null : null,
    due_label: r.due_label,
    status: r.status,
    reference: r.reference || null,
    created_at: r.created_at,
    paid_at: r.paid_at || null,
    direction: r.direction || "from_vendor",
    day_key: r.day_key || null,
    auto: Boolean(r.auto),
  };
}

export function utcDayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Sales totals for one vendor on a UTC calendar day (from ledger sale rows). */
export function getVendorDaySales(vendorId, dayKey = utcDayKey()) {
  const day = String(dayKey || utcDayKey());
  let gross_tzs = 0;
  let fee_tzs = 0;
  let net_tzs = 0;
  let sales_count = 0;
  for (const l of ledger) {
    if (l.vendor_id !== vendorId || l.type !== "sale") continue;
    if (String(l.created_at || "").slice(0, 10) !== day) continue;
    gross_tzs += l.gross_tzs || 0;
    fee_tzs += l.fee_tzs || 0;
    net_tzs += l.net_tzs || 0;
    sales_count += 1;
  }
  return {
    vendor_id: vendorId,
    day_key: day,
    gross_tzs: money(gross_tzs),
    fee_tzs: money(fee_tzs),
    net_tzs: money(net_tzs),
    sales_count,
  };
}

export function listVendorsDaySales(dayKey = utcDayKey()) {
  const day = String(dayKey || utcDayKey());
  const out = [];
  for (const v of vendors.values()) {
    const row = getVendorDaySales(v.id, day);
    if (row.sales_count <= 0 && row.net_tzs <= 0) continue;
    out.push({
      ...row,
      vendor_name: v.name,
      settlement_method: v.settlement_method || "mpesa",
      settlement_number: v.settlement_number || null,
    });
  }
  out.sort((a, b) => b.net_tzs - a.net_tzs);
  return out;
}

/**
 * Auto end-of-day: each vendor with sales that day gets a payout request
 * for their exact net earnings (what they sold that day, after platform fee).
 * Idempotent per vendor + day.
 */
export function generateEndOfDayVendorPayoutRequests(dayKey = utcDayKey()) {
  const day = String(dayKey || utcDayKey());
  const created = [];
  const skipped = [];
  for (const row of listVendorsDaySales(day)) {
    if (!(row.net_tzs > 0)) {
      skipped.push({ vendor_id: row.vendor_id, reason: "no_net" });
      continue;
    }
    const existing = [...paymentRequests.values()].find(
      (r) =>
        r.vendor_id === row.vendor_id &&
        r.day_key === day &&
        r.direction === "to_vendor" &&
        r.status !== "cancelled"
    );
    if (existing) {
      skipped.push({ vendor_id: row.vendor_id, reason: "already_exists", request_id: existing.id });
      continue;
    }
    const id = `pr_${crypto.randomBytes(5).toString("hex")}`;
    const req = {
      id,
      vendor_id: row.vendor_id,
      amount_tzs: row.net_tzs,
      gross_sales_tzs: row.gross_tzs,
      platform_fees_tzs: row.fee_tzs,
      reason: `End-of-day payout · ${day}`,
      method: String(row.settlement_method || "mpesa"),
      due_label: "End of day",
      status: "pending",
      reference: null,
      created_at: iso(new Date()),
      paid_at: null,
      direction: "to_vendor",
      day_key: day,
      auto: true,
    };
    paymentRequests.set(id, req);
    created.push(publicPaymentRequest(req));
  }
  return {
    day_key: day,
    created,
    skipped,
    vendors: listVendorsDaySales(day),
    requests: listAllPaymentRequests().filter((r) => r.day_key === day && r.direction === "to_vendor"),
  };
}

export function getEndOfDayFinanceSnapshot(dayKey = utcDayKey()) {
  const day = String(dayKey || utcDayKey());
  const vendors = listVendorsDaySales(day);
  const requests = listAllPaymentRequests().filter((r) => r.day_key === day && r.direction === "to_vendor");
  const total_net = vendors.reduce((s, v) => s + v.net_tzs, 0);
  const total_gross = vendors.reduce((s, v) => s + v.gross_tzs, 0);
  return {
    day_key: day,
    vendors,
    requests,
    totals: {
      vendors_with_sales: vendors.length,
      gross_sales_tzs: money(total_gross),
      net_payouts_tzs: money(total_net),
      pending_requests: requests.filter((r) => r.status === "pending").length,
    },
  };
}

/** Admin pays an end-of-day vendor payout request (platform → vendor). */
export function payVendorEndOfDayRequest(reqId, body = {}) {
  const r = paymentRequests.get(reqId);
  if (!r) throw new Error("Payment request not found");
  if (r.direction !== "to_vendor") throw new Error("Not a vendor payout request");
  if (r.status === "cancelled") throw new Error("Payment request was cancelled");
  if (r.status === "paid") return { request: publicPaymentRequest(r), payout: null, already: true };

  const payout = requestPayout(r.vendor_id, {
    amount_tzs: r.amount_tzs,
    method: body.method || r.method || "mpesa",
    destination: body.destination || "",
  });
  r.status = "paid";
  r.reference = String(body.reference || payout.id || "").trim() || payout.id;
  r.paid_at = iso(new Date());
  return { request: publicPaymentRequest(r), payout };
}

export function createVendorPaymentRequest(vendorId, body = {}) {
  const v = vendors.get(vendorId);
  if (!v) throw new Error("Vendor not found");
  const amount = money(Number(body.amount_tzs));
  if (!(amount > 0)) throw new Error("Invalid amount");
  const id = `pr_${crypto.randomBytes(5).toString("hex")}`;
  const row = {
    id,
    vendor_id: vendorId,
    amount_tzs: amount,
    reason: String(body.reason || "End-of-shift settlement").trim() || "End-of-shift settlement",
    method: String(body.method || v.settlement_method || "mpesa"),
    due_label: String(body.due_label || "End of shift").trim() || "End of shift",
    status: "pending",
    reference: null,
    created_at: iso(new Date()),
    paid_at: null,
    direction: body.direction === "to_vendor" ? "to_vendor" : "from_vendor",
    day_key: body.day_key ? String(body.day_key).slice(0, 10) : null,
    auto: Boolean(body.auto),
  };
  paymentRequests.set(id, row);
  return publicPaymentRequest(row);
}

export function listVendorPaymentRequests(vendorId) {
  return [...paymentRequests.values()]
    .filter((r) => r.vendor_id === vendorId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map(publicPaymentRequest);
}

export function listAllPaymentRequests() {
  return [...paymentRequests.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map(publicPaymentRequest);
}

export function markPaymentRequestPaid(reqId, body = {}) {
  const r = paymentRequests.get(reqId);
  if (!r) throw new Error("Payment request not found");
  if (r.status === "cancelled") throw new Error("Payment request was cancelled");
  r.status = "paid";
  r.reference = String(body.reference || "").trim() || r.reference;
  r.paid_at = iso(new Date());
  return publicPaymentRequest(r);
}

export function cancelPaymentRequest(reqId) {
  const r = paymentRequests.get(reqId);
  if (!r) throw new Error("Payment request not found");
  if (r.status === "paid") throw new Error("Paid requests cannot be cancelled");
  r.status = "cancelled";
  return publicPaymentRequest(r);
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

export function listVendorApplications({ status } = {}) {
  let rows = [...vendorApplications];
  if (status) rows = rows.filter((a) => a.status === status);
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function removeVendorApplication(appId) {
  const i = vendorApplications.findIndex((a) => a.id === appId);
  if (i < 0) throw new Error("Application not found");
  const app = vendorApplications[i];
  if (app.status !== "rejected") {
    throw new Error("Only rejected applications can be removed from the admin panel");
  }
  vendorApplications.splice(i, 1);
  return { ok: true, id: appId };
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
    city_id: normalizeCityKey(app.city_id) || normalizeCityKey(app.zone) || "dar",
    city: CITY_HUBS[normalizeCityKey(app.city_id) || normalizeCityKey(app.zone) || "dar"].city,
    pickup_label: `${app.business_name} (${app.zone})`,
    pickup_lat: CITY_HUBS[normalizeCityKey(app.city_id) || "dar"].lat + (Math.random() * 0.04 - 0.02),
    pickup_lng: CITY_HUBS[normalizeCityKey(app.city_id) || "dar"].lng + (Math.random() * 0.06 - 0.03),
    shop_phone: app.contact_phone,
    logo_url: null,
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
