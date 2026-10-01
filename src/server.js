import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../scripts/load-env.js";

loadEnvFile();
import {
  acceptOrder,
  addDemoRefund,
  advanceVendorOrder,
  appendPaymentEventUnique,
  approveVendorApplication,
  bulkUpdatePrices,
  createCategory,
  createOrder,
  createVendorApplication,
  createProduct,
  createRefundRequest,
  createWalletPaymentIntent,
  declineOrder,
  getOrder,
  getPayment,
  getVendor,
  getCommissionSettings,
  getVendorDashboard,
  getVendorEarnings,
  getVendorPayoutHistory,
  ledgerStatementCsv,
  listCategories,
  listProducts,
  listProductsNear,
  listPublicProducts,
  listRefundRequests,
  listVendorApplications,
  listVendorOrders,
  listVendorProducts,
  listVendorNotifications,
  ackVendorNotifications,
  quoteDeliveryFare,
  notifyVendorPaymentReceived,
  normalizeMsisdnTz,
  rejectVendorApplication,
  removeVendorApplication,
  requestPayout,
  createVendorPaymentRequest,
  listVendorPaymentRequests,
  listAllPaymentRequests,
  markPaymentRequestPaid,
  cancelPaymentRequest,
  generateEndOfDayVendorPayoutRequests,
  getEndOfDayFinanceSnapshot,
  payVendorEndOfDayRequest,
  utcDayKey,
  setRefundRequestStatus,
  setVendorShopOpen,
  updateVendorProfile,
  updatePayment,
  updateProduct,
  adminPauseVendor,
  setCommissionForCategory,
} from "./store.js";
import { transitionOrder } from "./orderMachine.js";
import { getAdapter } from "./payments/adapters.js";
import {
  getMpesaSettings,
  isMpesaCheckoutEnabled,
  isWalletEnvGateOpen,
  updateMpesaSettings,
  validateMpesaConfig,
} from "./mpesaSettings.js";
import { getBankSettings, getPublicBankCheckout, isBankCheckoutEnabled, updateBankSettings } from "./bankSettings.js";
import {
  getPayoutMpesaSettings,
  getPayoutMpesaSummary,
  updatePayoutMpesaSettings,
} from "./payoutAccountSettings.js";
import {
  addDeliveryCity,
  getDeliveryCitiesMeta,
  listDeliveryCities,
  removeDeliveryCity,
  resetDeliveryCities,
} from "./deliveryCities.js";
import * as drv from "./drivers.js";
import * as admin from "./admin.js";
import {
  authenticateUser,
  changeUserPassword,
  createSession,
  createUser,
  deleteSession,
  getUserBySession,
  seedAuthUsers,
  setUserVendorId,
  SESSION_TTL_MS,
  updateUserProfile,
  userHasVendorAccess,
  userHasVerifiedDriverAccess,
  userIsAdmin,
} from "./auth.js";
import {
  approveDriverApplication,
  buildAccountProfile,
  createDriverApplication,
  getOrderForCustomer,
  listDriverApplications,
  rejectDriverApplication,
  removeDriverApplication,
} from "./account.js";
import {
  notifyDriverApplicationApproved,
  notifyDriverApplicationRejected,
  notifyVendorApplicationApproved,
  notifyVendorApplicationRejected,
} from "./notifications.js";
import * as support from "./support.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3780);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev_webhook_secret_change_me";
const DEV_TOOLS = process.env.ENABLE_DEV_TOOLS === "1" || process.env.NODE_ENV !== "production";
// Simulated wallet payments remain available for local QA, never for a public deployment
// unless a real provider integration explicitly enables them.
const WALLET_PAYMENTS_ENABLED = process.env.WALLET_PAYMENTS_ENABLED === "1" || process.env.NODE_ENV !== "production";
const API_RATE_LIMIT_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000);
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 120);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);

const publicDir = path.join(__dirname, "../public");
const assetsDir = path.join(publicDir, "assets");
const apiRateWindow = new Map();

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(self), microphone=()",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self' https://router.project-osrm.org; img-src 'self' data: https://*.tile.openstreetmap.org https://*.openstreetmap.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; script-src 'self' 'unsafe-inline' https://unpkg.com; font-src 'self' https://fonts.gstatic.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...extra,
  };
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    ...securityHeaders(),
    ...extraHeaders,
  };
  // Preserve session cookie set earlier in the request (login / sliding renew / logout).
  const existingCookie = res.getHeader("Set-Cookie");
  if (existingCookie && headers["Set-Cookie"] == null) {
    headers["Set-Cookie"] = existingCookie;
  }
  res.writeHead(status, headers);
  res.end(data);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Content-Disposition": 'attachment; filename="statement.csv"',
    ...securityHeaders(),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => chunks.push(c));
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function signMockWebhook(payment_id, amount_tzs, status) {
  const payload = `${payment_id}:${amount_tzs}:${status}`;
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
}

function verifyMockSignature(payment_id, amount_tzs, status, signature) {
  const expected = signMockWebhook(payment_id, amount_tzs, status);
  const a = Buffer.from(String(signature), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function moneySafe(v, fallback) {
  const n = Number(v);
  const fb = Math.round(Number(fallback) || 0);
  if (!Number.isFinite(n) || n <= 0) return fb;
  return Math.round(n);
}

function requestBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:3780").split(",")[0].trim();
  return `${proto}://${host}`;
}

async function sendFile(res, filePath, contentType) {
  const buf = await fs.readFile(filePath);
  const isHtml = contentType.startsWith("text/html");
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    ...securityHeaders(
      filePath.endsWith("sw.js")
        ? {
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          }
        : isHtml
          ? {
              "Cache-Control": "no-cache, no-store, must-revalidate",
              Pragma: "no-cache",
              Expires: "0",
            }
          : {}
    ),
  });
  res.end(buf);
}

function getClientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

function checkApiRateLimit(req, now = Date.now()) {
  const ip = getClientIp(req);
  const k = `${ip}:${Math.floor(now / API_RATE_LIMIT_WINDOW_MS)}`;
  const next = (apiRateWindow.get(k) || 0) + 1;
  apiRateWindow.set(k, next);
  if (apiRateWindow.size > 5000) {
    const minAllowed = Math.floor(now / API_RATE_LIMIT_WINDOW_MS) - 2;
    for (const key of apiRateWindow.keys()) {
      const p = Number(String(key).split(":").pop() || 0);
      if (!Number.isFinite(p) || p < minAllowed) apiRateWindow.delete(key);
    }
  }
  return next <= API_RATE_LIMIT_MAX;
}

function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function sessionCookieValue(sid) {
  const maxAge = Math.max(60, Math.floor(Number(SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 30) / 1000));
  const isProd = process.env.NODE_ENV === "production";
  const cookie = [
    `sid=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isProd) cookie.push("Secure");
  return cookie.join("; ");
}

function setSessionCookie(res, sid) {
  res.setHeader("Set-Cookie", sessionCookieValue(sid));
}

function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === "production";
  const cookie = ["sid=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isProd) cookie.push("Secure");
  res.setHeader("Set-Cookie", cookie.join("; "));
}

function requireAuth(user) {
  if (!user) throw new Error("Authentication required");
}

function requireRole(user, roles) {
  requireAuth(user);
  if (!roles.includes(user.role)) throw new Error("Forbidden");
}

function requireVendorAccess(user) {
  requireAuth(user);
  if (!userHasVendorAccess(user) && !userIsAdmin(user)) throw new Error("Forbidden");
}

function requireVerifiedDriverAccess(user) {
  requireAuth(user);
  if (!userHasVerifiedDriverAccess(user) && !userIsAdmin(user)) throw new Error("Forbidden");
}

function assertDriverSelfOrAdmin(actor, driverId) {
  requireVerifiedDriverAccess(actor);
  if (!userIsAdmin(actor) && actor.driver_id !== driverId) throw new Error("Forbidden");
}

function assertAllowedFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid payload");
  const extras = Object.keys(body).filter((k) => !allowed.has(k));
  if (extras.length) throw new Error(`Unexpected field(s): ${extras.join(", ")}`);
}

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in production. Refusing to start with non-durable application data.");
}

const authReady = Promise.all([seedAuthUsers(), support.ready()]);

const PUBLIC_SIGNUP_ROLES = new Set(["shopper", "vendor", "driver"]);

function normalizeEmailList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function canCreateAdminAccount({ email, admin_code }) {
  const allowed = normalizeEmailList(process.env.ALLOWED_ADMIN_EMAILS);
  const emailN = String(email || "")
    .trim()
    .toLowerCase();
  if (emailN && allowed.includes(emailN)) return true;
  const invite = String(process.env.ADMIN_INVITE_CODE || "").trim();
  const code = String(admin_code || "").trim();
  if (invite && code && invite.length >= 8 && code === invite) return true;
  return false;
}

function isAllowedAdminEmail(email) {
  const emailN = String(email || "")
    .trim()
    .toLowerCase();
  return Boolean(emailN && normalizeEmailList(process.env.ALLOWED_ADMIN_EMAILS).includes(emailN));
}

const signupSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().min(8).max(20).optional(),
    email: z.string().trim().email().optional(),
    password: z.string().min(6).max(200),
    locale: z.string().trim().min(2).max(10).optional(),
    role: z.enum(["shopper", "vendor", "driver", "admin"]).default("shopper"),
    admin_code: z.string().trim().min(1).max(64).optional(),
    business_name: z.string().trim().min(2).max(160).optional(),
    zone: z.string().trim().min(2).max(80).optional(),
    national_id: z.string().trim().min(5).max(40).optional(),
    license_number: z.string().trim().min(4).max(40).optional(),
    license_expiry: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    vehicle_type: z.string().trim().min(2).max(40).optional(),
    vehicle_make: z.string().trim().min(2).max(60).optional(),
    vehicle_model: z.string().trim().min(1).max(60).optional(),
    vehicle_year: z.coerce.number().int().min(1980).max(new Date().getFullYear() + 1).optional(),
    vehicle_plate: z.string().trim().min(3).max(20).optional(),
    vehicle_color: z.string().trim().max(40).optional(),
    emergency_contact: z.string().trim().max(120).optional(),
  })
  .refine((v) => Boolean(v.phone || v.email), { message: "phone or email required" })
  .refine((v) => v.role !== "vendor" || Boolean(v.business_name), {
    message: "business_name required for vendor signup",
  })
  .refine((v) => v.role !== "vendor" || Boolean(v.zone), { message: "zone required for vendor signup" })
  .refine((v) => v.role !== "vendor" || Boolean(v.phone), { message: "phone required for vendor signup" })
  .refine((v) => v.role !== "driver" || Boolean(v.phone), { message: "phone required for driver signup" })
  .refine((v) => v.role !== "driver" || Boolean(v.national_id), { message: "national_id required for driver signup" })
  .refine((v) => v.role !== "driver" || Boolean(v.license_number), {
    message: "license_number required for driver signup",
  })
  .refine((v) => v.role !== "driver" || Boolean(v.license_expiry), {
    message: "license_expiry required for driver signup",
  })
  .refine((v) => v.role !== "driver" || Boolean(v.vehicle_type), { message: "vehicle_type required for driver signup" })
  .refine((v) => v.role !== "driver" || Boolean(v.vehicle_make), { message: "vehicle_make required for driver signup" })
  .refine((v) => v.role !== "driver" || Boolean(v.vehicle_model), { message: "vehicle_model required for driver signup" })
  .refine((v) => v.role !== "driver" || v.vehicle_year != null, { message: "vehicle_year (year made) required for driver signup" })
  .refine((v) => v.role !== "driver" || Boolean(v.vehicle_plate), {
    message: "vehicle_plate required for driver signup",
  });

const loginSchema = z
  .object({
    phone: z.string().trim().min(8).max(20).optional(),
    email: z.string().trim().email().optional(),
    password: z.string().min(1).max(200),
  })
  .refine((v) => Boolean(v.phone || v.email), { message: "phone or email required" });

const orderCreateSchema = z.object({
  customer_phone: z.string().trim().min(8).max(20),
  customer_name: z.string().trim().min(1).max(120).optional(),
  dropoff_label: z.string().trim().min(5).max(500),
  customer_city: z.string().trim().min(2).max(80).optional(),
  delivery_area: z.string().trim().min(1).max(80).optional(),
  dropoff_lat: z.number().finite().optional(),
  dropoff_lng: z.number().finite().optional(),
  items: z.array(z.object({ product_id: z.string().trim().min(1).max(64), qty: z.number().int().min(1).max(999) })).min(1),
  payment_method: z.enum(["mpesa"]),
  vendor_id: z.string().trim().min(1).max(64),
});

const paymentInitSchema = z.object({
  order_id: z.string().trim().min(1).max(64),
  provider: z.enum(["mpesa"]),
  msisdn: z.string().trim().min(8).max(20),
  idempotency_key: z.string().trim().min(1).max(128).optional(),
});

const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().min(8).max(20).optional(),
    email: z.string().trim().email().optional(),
    locale: z.string().trim().min(2).max(10).optional(),
    avatar_url: z.union([z.string().max(220000), z.null()]).optional(),
    current_password: z.string().min(1).max(200).optional(),
    new_password: z.string().min(8).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No profile fields provided" })
  .refine((v) => {
    if (v.new_password && !v.current_password) return false;
    return true;
  }, { message: "current_password required when changing password" });

const vendorProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    zone: z.string().trim().min(1).max(80).optional(),
    pickup_label: z.string().trim().min(3).max(300).optional(),
    shop_phone: z.string().trim().min(8).max(24).optional(),
    shop_open: z.boolean().optional(),
    settlement_method: z.string().trim().min(2).max(40).optional(),
    settlement_number: z.string().trim().max(80).optional(),
    logo_url: z.union([z.string().max(220000), z.null()]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No vendor profile fields provided" });

function parseWithSchema(schema, body) {
  const out = schema.safeParse(body);
  if (!out.success) {
    const issues = out.error.issues.slice(0, 3).map((i) => i.message).join("; ");
    throw new Error(`Invalid payload: ${issues}`);
  }
  return out.data;
}

function canAccessOrder(user, order) {
  if (!user || !order) return false;
  if (userIsAdmin(user)) return true;
  if (order.customer_user_id && order.customer_user_id === user.id) return true;
  if (userHasVendorAccess(user) && user.vendor_id === order.vendor_id) return true;
  if (userHasVerifiedDriverAccess(user) && user.driver_id && drv.isOrderAssignedToDriver(order.id, user.driver_id)) {
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      ...securityHeaders(),
    });
    return res.end();
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const cookies = parseCookies(req.headers.cookie);
  await authReady;
  const actor = await getUserBySession(cookies.sid);
  // Refresh the browser cookie whenever the session is still valid (until Sign out).
  if (actor && cookies.sid) {
    setSessionCookie(res, cookies.sid);
  }
  // eslint-disable-next-line no-console
  console.log(
    `${new Date().toISOString()} ${req.method} ${url.pathname} ip=${getClientIp(req)} actor=${actor?.id || "anon"}`
  );

  if (url.pathname.startsWith("/api/") && !checkApiRateLimit(req)) {
    return json(res, 429, { error: "Too many requests. Please retry shortly." });
  }

  try {
    if (req.method === "GET" && url.pathname === "/") {
      return sendFile(res, path.join(publicDir, "landing.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/shop" || url.pathname === "/shop/")) {
      return sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/vendor" || url.pathname === "/vendor/")) {
      return sendFile(res, path.join(publicDir, "vendor.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/driver" || url.pathname === "/driver/")) {
      return sendFile(res, path.join(publicDir, "driver.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      return sendFile(res, path.join(publicDir, "admin.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/account" || url.pathname === "/account/")) {
      return sendFile(res, path.join(publicDir, "account.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/privacy" || url.pathname === "/privacy/")) {
      return sendFile(res, path.join(publicDir, "privacy.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && (url.pathname === "/terms" || url.pathname === "/terms/")) {
      return sendFile(res, path.join(publicDir, "terms.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      return sendFile(res, path.join(publicDir, "manifest.webmanifest"), "application/manifest+json; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/sw.js") {
      return sendFile(res, path.join(publicDir, "sw.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      return sendFile(res, path.join(assetsDir, "favicon.svg"), "image/svg+xml");
    }
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const rel = url.pathname.slice("/assets/".length);
      const parts = rel.split("/").filter(Boolean);
      if (parts.length === 0) return json(res, 404, { error: "not found" });
      if (parts.some((p) => p === "..")) return json(res, 400, { error: "invalid path" });
      const filePath = path.join(assetsDir, ...parts);
      const fileResolved = path.resolve(filePath);
      const rootResolved = path.resolve(assetsDir);
      if (fileResolved !== rootResolved && !fileResolved.startsWith(rootResolved + path.sep)) {
        return json(res, 403, { error: "forbidden" });
      }
      const ext = path.extname(fileResolved).toLowerCase();
      const mime =
        ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "text/javascript; charset=utf-8"
            : ext === ".svg"
              ? "image/svg+xml"
              : ext === ".png"
                ? "image/png"
                : "application/octet-stream";
      try {
        const stat = await fs.stat(fileResolved);
        if (!stat.isFile()) return json(res, 404, { error: "not found" });
        return sendFile(res, fileResolved, mime);
      } catch {
        return json(res, 404, { error: "not found" });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        region: "TZ",
        currency: "TZS",
        dev_tools: DEV_TOOLS,
        wallet_payments_enabled: WALLET_PAYMENTS_ENABLED,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/public-config") {
      return json(res, 200, {
        wallet_payments_enabled: WALLET_PAYMENTS_ENABLED,
        mpesa_enabled: isMpesaCheckoutEnabled(),
        bank_enabled: isBankCheckoutEnabled(),
        bank: getPublicBankCheckout(),
        delivery_cities: listDeliveryCities(),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/delivery/cities") {
      return json(res, 200, { cities: listDeliveryCities() });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      const body = await readBody(req);
      assertAllowedFields(
        body,
        new Set([
          "name",
          "phone",
          "email",
          "password",
          "locale",
          "role",
          "admin_code",
          "business_name",
          "zone",
          "national_id",
          "license_number",
          "license_expiry",
          "vehicle_type",
          "vehicle_make",
          "vehicle_model",
          "vehicle_year",
          "vehicle_plate",
          "vehicle_color",
          "emergency_contact",
        ])
      );
      const data = parseWithSchema(signupSchema, body);
      let role = data.role || "shopper";
      if (role === "admin") {
        if (!canCreateAdminAccount({ email: data.email, admin_code: data.admin_code })) {
          return json(res, 403, { error: "Admin accounts are by invitation only" });
        }
      } else if (!PUBLIC_SIGNUP_ROLES.has(role)) {
        return json(res, 400, { error: "Invalid account type" });
      }

      // Bootstrap emails are always admins, even if their original account was
      // created as a shopper before the allow-list was configured.
      const accountRole = role === "admin" || isAllowedAdminEmail(data.email) ? "admin" : "shopper";
      const user = await createUser({ ...data, role: accountRole });
      let vendor_application = null;
      let driver_application = null;
      if (role === "vendor") {
        vendor_application = createVendorApplication({
          business_name: data.business_name,
          contact_phone: data.phone,
          zone: data.zone,
          contact_name: data.name,
          contact_email: data.email,
          user_id: user.id,
        });
      }
      if (role === "driver") {
        driver_application = await createDriverApplication({
          user_id: user.id,
          user_snapshot: user,
          full_name: data.name,
          phone: data.phone,
          national_id: data.national_id,
          license_number: data.license_number,
          license_expiry: data.license_expiry,
          vehicle_type: data.vehicle_type,
          vehicle_make: data.vehicle_make,
          vehicle_model: data.vehicle_model,
          vehicle_year: data.vehicle_year,
          vehicle_plate: data.vehicle_plate,
          vehicle_color: data.vehicle_color,
          emergency_contact: data.emergency_contact,
        });
      }

      const sid = await createSession(user.id);
      setSessionCookie(res, sid);
      return json(res, 201, {
        user,
        vendor_application,
        driver_application,
        next_step:
          role === "vendor"
            ? "vendor_pending_approval"
            : role === "driver"
              ? "driver_pending_approval"
              : role === "admin"
                ? "open_admin"
                : "shop",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["phone", "email", "password"]));
      const data = parseWithSchema(loginSchema, body);
      const user = await authenticateUser(data);
      // Keep this deliberately generic: do not reveal whether an account exists.
      if (!user) return json(res, 401, { error: "Incorrect email, phone number, or password" });
      const sid = await createSession(user.id);
      setSessionCookie(res, sid);
      return json(res, 200, { user });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      if (cookies.sid) await deleteSession(cookies.sid);
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      if (!actor) return json(res, 401, { error: "Not authenticated" });
      return json(res, 200, { user: actor });
    }
    if (req.method === "PATCH" && url.pathname === "/api/auth/me") {
      requireAuth(actor);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["name", "phone", "email", "locale", "avatar_url", "current_password", "new_password"]));
      const parsed = parseWithSchema(profilePatchSchema, body);
      const profileInput = {
        name: parsed.name,
        phone: parsed.phone,
        email: parsed.email,
        locale: parsed.locale,
        avatar_url: parsed.avatar_url,
      };
      const hasProfileChanges = Object.values(profileInput).some((x) => x !== undefined);
      const user = hasProfileChanges ? await updateUserProfile(actor.id, profileInput) : actor;
      if (parsed.new_password) {
        await changeUserPassword(actor.id, parsed.current_password, parsed.new_password);
      }
      return json(res, 200, { user, password_updated: Boolean(parsed.new_password) });
    }

    if (req.method === "GET" && url.pathname === "/api/account") {
      requireAuth(actor);
      return json(res, 200, { account: await buildAccountProfile(actor) });
    }

    if (req.method === "POST" && url.pathname === "/api/account/vendor-application") {
      requireAuth(actor);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["business_name", "contact_phone", "zone", "contact_name", "contact_email"]));
      if (userHasVendorAccess(actor)) return json(res, 400, { error: "You already have an active vendor account" });
      const app = createVendorApplication({
        business_name: body.business_name,
        contact_phone: body.contact_phone || actor.phone,
        zone: body.zone,
        contact_name: body.contact_name || actor.name,
        contact_email: body.contact_email || actor.email,
        user_id: actor.id,
      });
      return json(res, 201, { application: app });
    }

    if (req.method === "POST" && url.pathname === "/api/account/driver-application") {
      requireAuth(actor);
      const body = await readBody(req);
      assertAllowedFields(
        body,
        new Set([
          "full_name",
          "phone",
          "national_id",
          "license_number",
          "license_expiry",
          "vehicle_type",
          "vehicle_make",
          "vehicle_model",
          "vehicle_year",
          "vehicle_plate",
          "vehicle_color",
          "emergency_contact",
          "notes",
        ])
      );
      const app = await createDriverApplication({ ...body, user_id: actor.id, user_snapshot: actor });
      return json(res, 201, { application: app });
    }

    const accountOrderGet = req.method === "GET" && url.pathname.match(/^\/api\/account\/orders\/([^/]+)$/);
    if (accountOrderGet) {
      requireAuth(actor);
      const o = getOrderForCustomer(actor.id, accountOrderGet[1]);
      if (!o) return json(res, 404, { error: "Not found" });
      return json(res, 200, { order: o });
    }

    if (req.method === "GET" && url.pathname === "/api/support/thread") {
      requireAuth(actor);
      const thread = await support.getUserThread(actor);
      return json(res, 200, thread);
    }
    if (req.method === "POST" && url.pathname === "/api/support/messages") {
      requireAuth(actor);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["body"]));
      const message = await support.postUserMessage(actor, body.body);
      return json(res, 201, { message });
    }
    const supDel = req.method === "DELETE" && url.pathname.match(/^\/api\/support\/messages\/([^/]+)$/);
    if (supDel) {
      requireAuth(actor);
      const out = await support.deleteUserMessage(actor, supDel[1]);
      return json(res, 200, out);
    }
    if (req.method === "POST" && url.pathname === "/api/support/read") {
      requireAuth(actor);
      await support.markReadForUser(actor);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/products") {
      const vendorId = url.searchParams.get("vendor_id");
      if (vendorId) {
        return json(res, 200, { products: listPublicProducts(vendorId) });
      }
      const city = url.searchParams.get("city") || undefined;
      const cityId = url.searchParams.get("city_id") || undefined;
      const latRaw = url.searchParams.get("lat");
      const lngRaw = url.searchParams.get("lng");
      const lat = latRaw != null && latRaw !== "" ? Number(latRaw) : undefined;
      const lng = lngRaw != null && lngRaw !== "" ? Number(lngRaw) : undefined;
      const radiusKm = url.searchParams.get("radius_km") ? Number(url.searchParams.get("radius_km")) : undefined;
      if (city || cityId || (Number.isFinite(lat) && Number.isFinite(lng))) {
        const near = listProductsNear({ city, cityId, lat, lng, radiusKm });
        return json(res, 200, near);
      }
      return json(res, 200, { products: listProducts() });
    }

    if (req.method === "GET" && url.pathname === "/api/delivery/quote") {
      const vendorId = url.searchParams.get("vendor_id");
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      const vehicle = url.searchParams.get("vehicle_class") || "boda";
      try {
        const quote = quoteDeliveryFare({
          vendor_id: vendorId,
          dropoff_lat: lat,
          dropoff_lng: lng,
          vehicle_class: vehicle,
        });
        return json(res, 200, { quote });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/orders") {
      requireAuth(actor);
      const body = await readBody(req);
      assertAllowedFields(
        body,
        new Set([
          "customer_phone",
          "customer_name",
          "dropoff_label",
          "customer_city",
          "delivery_area",
          "dropoff_lat",
          "dropoff_lng",
          "items",
          "payment_method",
          "vendor_id",
        ])
      );
      const parsed = parseWithSchema(orderCreateSchema, body);
      const order = createOrder({ ...parsed, customer_user_id: actor.id });
      return json(res, 201, { order });
    }

    if (req.method === "POST" && url.pathname === "/api/vendor-applications") {
      requireAuth(actor);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["business_name", "contact_phone", "zone", "contact_name", "contact_email"]));
      const app = createVendorApplication({ ...body, user_id: actor.id });
      return json(res, 201, { application: app });
    }

    const orderGet = req.method === "GET" && url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderGet) {
      requireAuth(actor);
      const o = getOrder(orderGet[1]);
      if (!o) return json(res, 404, { error: "Not found" });
      if (!canAccessOrder(actor, o)) return json(res, 403, { error: "Forbidden" });
      return json(res, 200, { order: o });
    }

    if (req.method === "POST" && url.pathname === "/api/payments/initiate") {
      requireAuth(actor);
      if (!WALLET_PAYMENTS_ENABLED) {
        return json(res, 503, {
          error: "M-Pesa payments are not available yet. Ask an admin to enable wallet payments.",
        });
      }
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["order_id", "provider", "msisdn", "idempotency_key"]));
      const { order_id, provider, msisdn, idempotency_key } = parseWithSchema(paymentInitSchema, body);
      if (!isMpesaCheckoutEnabled()) {
        return json(res, 503, {
          error: "M-Pesa checkout is disabled. Ask an admin to enable M-Pesa credentials in settings.",
        });
      }
      normalizeMsisdnTz(msisdn);
      const order = getOrder(order_id);
      if (!order) return json(res, 404, { error: "order not found" });
      if (!canAccessOrder(actor, order)) return json(res, 403, { error: "Forbidden" });
      const payment = await createWalletPaymentIntent({
        order_id,
        provider,
        msisdn,
        idempotency_key,
      });
      if (order && order.status === "placed") {
        transitionOrder(order, "payment_pending");
      }
      const adapter = getAdapter(provider);
      const instructions = adapter.initiatePayment({ payment });
      return json(res, 201, { payment, instructions, order });
    }

    const payConfirmDemo =
      req.method === "POST" && url.pathname.match(/^\/api\/payments\/([^/]+)\/confirm-demo$/);
    if (payConfirmDemo) {
      if (!DEV_TOOLS) return json(res, 404, { error: "not found" });
      requireAuth(actor);
      if (!WALLET_PAYMENTS_ENABLED) return json(res, 503, { error: "Mobile-money payments are not available" });
      const paymentId = payConfirmDemo[1];
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["status"]));
      const status = String(body.status || "paid");
      if (status !== "paid" && status !== "failed") {
        return json(res, 400, { error: "status must be paid or failed" });
      }
      const payment = getPayment(paymentId);
      if (!payment) return json(res, 404, { error: "payment not found" });
      const order = getOrder(payment.order_id);
      if (!order) return json(res, 404, { error: "order not found" });
      if (!canAccessOrder(actor, order)) return json(res, 403, { error: "Forbidden" });
      if (payment.status === "paid" && status === "paid") {
        return json(res, 200, { ok: true, order, payment, already: true });
      }
      if (payment.status !== "pending") {
        return json(res, 409, { error: `payment not pending (${payment.status})` });
      }
      const event_id = `demo_${crypto.randomBytes(6).toString("hex")}`;
      await appendPaymentEventUnique(event_id);
      if (status === "paid") {
        updatePayment(payment.id, {
          status: "paid",
          paid_at: new Date().toISOString(),
          provider_reference: event_id,
        });
        if (order.status === "payment_pending") transitionOrder(order, "paid");
        if (order.status === "paid") {
          notifyVendorPaymentReceived(order, getPayment(payment.id));
          transitionOrder(order, "new");
        }
        return json(res, 200, {
          ok: true,
          order: getOrder(order.id),
          payment: getPayment(payment.id),
          vendor_notified: true,
        });
      }
      updatePayment(payment.id, { status: "failed", failed_at: new Date().toISOString() });
      if (order.status === "payment_pending") transitionOrder(order, "cancelled");
      return json(res, 200, { ok: true, order: getOrder(order.id), payment: getPayment(payment.id) });
    }

    const hook = req.method === "POST" && url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
    if (hook) {
      if (!WALLET_PAYMENTS_ENABLED) return json(res, 404, { error: "not found" });
      const provider = hook[1];
      getAdapter(provider);
      const body = await readBody(req);
      const { event_id, payment_id, status, amount_tzs, signature } = body;
      if (!event_id || !payment_id || !status || amount_tzs == null || !signature) {
        return json(res, 400, { error: "event_id, payment_id, status, amount_tzs, signature required" });
      }

      if (!(await appendPaymentEventUnique(String(event_id)))) {
        return json(res, 200, { ok: true, duplicate: true });
      }

      const payment = getPayment(payment_id);
      if (!payment) return json(res, 404, { error: "payment not found" });
      if (payment.provider !== provider) return json(res, 400, { error: "provider mismatch" });

      if (!verifyMockSignature(payment_id, Number(amount_tzs), String(status), signature)) {
        return json(res, 401, { error: "invalid signature" });
      }

      const order = getOrder(payment.order_id);
      if (!order) return json(res, 404, { error: "order not found" });

      if (Number(amount_tzs) !== payment.amount_tzs) {
        return json(res, 400, { error: "amount mismatch" });
      }

      if (status === "paid") {
        if (payment.status === "paid") {
          return json(res, 200, { ok: true, order, payment });
        }
        if (payment.status !== "pending") {
          return json(res, 409, { error: `payment not pending (${payment.status})` });
        }
        updatePayment(payment.id, {
          status: "paid",
          paid_at: new Date().toISOString(),
          provider_reference: String(event_id),
        });
        transitionOrder(order, "paid");
        const paidPayment = getPayment(payment.id);
        notifyVendorPaymentReceived(order, paidPayment);
        transitionOrder(order, "new");
        return json(res, 200, { ok: true, order, payment: paidPayment, vendor_notified: true });
      }

      if (status === "failed") {
        if (payment.status !== "pending") {
          return json(res, 409, { error: `payment not pending (${payment.status})` });
        }
        updatePayment(payment.id, { status: "failed", failed_at: new Date().toISOString() });
        transitionOrder(order, "cancelled");
        return json(res, 200, { ok: true, order, payment: getPayment(payment.id) });
      }

      return json(res, 400, { error: "unsupported status" });
    }

    if (req.method === "POST" && url.pathname === "/api/dev/sign-webhook") {
      if (!DEV_TOOLS) return json(res, 404, { error: "not found" });
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["payment_id", "amount_tzs", "status"]));
      const { payment_id, amount_tzs, status } = body;
      if (!payment_id || amount_tzs == null || !status) {
        return json(res, 400, { error: "payment_id, amount_tzs, status required" });
      }
      const signature = signMockWebhook(String(payment_id), Number(amount_tzs), String(status));
      return json(res, 200, { signature, webhook_secret_note: "server uses WEBHOOK_SECRET env" });
    }

    const vidPatch = req.method === "PATCH" && url.pathname.match(/^\/api\/vendors\/([^/]+)$/);
    if (vidPatch) {
      const vendorId = vidPatch[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      if (!getVendor(vendorId)) return json(res, 404, { error: "vendor not found" });
      const body = await readBody(req);
      if (body.shop_open === undefined) return json(res, 400, { error: "shop_open required" });
      const v = setVendorShopOpen(vendorId, body.shop_open);
      return json(res, 200, { vendor: v });
    }
    const vidProfilePatch = req.method === "PATCH" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/profile$/);
    if (vidProfilePatch) {
      const vendorId = vidProfilePatch[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      if (!getVendor(vendorId)) return json(res, 404, { error: "vendor not found" });
      const body = await readBody(req);
      assertAllowedFields(
        body,
        new Set(["name", "zone", "pickup_label", "shop_phone", "shop_open", "settlement_method", "settlement_number", "logo_url"])
      );
      const parsed = parseWithSchema(vendorProfilePatchSchema, body);
      const vendor = updateVendorProfile(vendorId, parsed);
      return json(res, 200, { vendor });
    }

    const dashM = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/dashboard$/);
    if (dashM) {
      const vendorId = dashM[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const dash = getVendorDashboard(vendorId);
      if (!dash) return json(res, 404, { error: "vendor not found" });
      return json(res, 200, dash);
    }

    const catGet = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/categories$/);
    if (catGet) {
      const vendorId = catGet[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      if (!getVendor(vendorId)) return json(res, 404, { error: "vendor not found" });
      return json(res, 200, { categories: listCategories(vendorId) });
    }

    const catPost = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/categories$/);
    if (catPost) {
      const vendorId = catPost[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      const c = createCategory(vendorId, body);
      return json(res, 201, { category: c });
    }

    const prodGet = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/products$/);
    if (prodGet) {
      const vendorId = prodGet[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      if (!getVendor(vendorId)) return json(res, 404, { error: "vendor not found" });
      const include = url.searchParams.get("include_inactive") === "1";
      return json(res, 200, { products: listVendorProducts(vendorId, { include_inactive: include }) });
    }

    const prodPost = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/products$/);
    if (prodPost) {
      const vendorId = prodPost[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      const p = createProduct(vendorId, body);
      return json(res, 201, { product: p });
    }

    const prodPatch = req.method === "PATCH" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/products\/([^/]+)$/);
    if (prodPatch) {
      const [, vendorId, productId] = prodPatch;
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      const p = updateProduct(vendorId, productId, body);
      if (!p) return json(res, 404, { error: "not found" });
      return json(res, 200, { product: p });
    }

    const bulkM = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/products\/bulk-prices$/);
    if (bulkM) {
      const vendorId = bulkM[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      const updated = bulkUpdatePrices(vendorId, body.updates);
      return json(res, 200, { updated });
    }

    const ordGet = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/orders$/);
    if (ordGet) {
      const vendorId = ordGet[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      if (!getVendor(vendorId)) return json(res, 404, { error: "vendor not found" });
      const scope = url.searchParams.get("scope") || "all";
      const orders = listVendorOrders(vendorId, { scope });
      return json(res, 200, { orders });
    }

    const notifGet = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/notifications$/);
    if (notifGet) {
      const vendorId = notifGet[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      if (!getVendor(vendorId)) return json(res, 404, { error: "vendor not found" });
      const unreadOnly = url.searchParams.get("unread") === "1";
      return json(res, 200, {
        notifications: listVendorNotifications(vendorId, { unreadOnly }),
        unread_count: listVendorNotifications(vendorId, { unreadOnly: true }).length,
      });
    }

    const notifAck = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/notifications\/ack$/);
    if (notifAck) {
      const vendorId = notifAck[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      if (!getVendor(vendorId)) return json(res, 404, { error: "vendor not found" });
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      return json(res, 200, ackVendorNotifications(vendorId, ids));
    }

    const acceptM = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/orders\/([^/]+)\/accept$/);
    if (acceptM) {
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== acceptM[1]) return json(res, 403, { error: "Forbidden" });
      const o = acceptOrder(acceptM[1], acceptM[2]);
      return json(res, 200, { order: o });
    }

    const declineM = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/orders\/([^/]+)\/decline$/);
    if (declineM) {
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== declineM[1]) return json(res, 403, { error: "Forbidden" });
      const o = declineOrder(declineM[1], declineM[2]);
      return json(res, 200, { order: o });
    }

    const advanceM = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/orders\/([^/]+)\/advance$/);
    if (advanceM) {
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== advanceM[1]) return json(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      const to = String(body.to || "ready_for_pickup");
      const o = advanceVendorOrder(advanceM[1], advanceM[2], to);
      if (o.status === "ready_for_pickup") {
        drv.startDispatchForOrder(o);
      }
      return json(res, 200, { order: o });
    }

    const drvPatch = req.method === "PATCH" && url.pathname.match(/^\/api\/drivers\/([^/]+)$/);
    if (drvPatch) {
      const id = drvPatch[1];
      assertDriverSelfOrAdmin(actor, id);
      const body = await readBody(req);
      if (body.lat != null && body.lng != null) {
        drv.setDriverLocation(id, body.lat, body.lng);
      }
      if (body.online !== undefined) {
        drv.setDriverOnline(id, body.online, body.lat, body.lng);
      }
      return json(res, 200, { driver: drv.getDriver(id) });
    }

    const drvGet = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)$/);
    if (drvGet) {
      assertDriverSelfOrAdmin(actor, drvGet[1]);
      const d = drv.getDriver(drvGet[1]);
      if (!d) throw new Error("Driver not found");
      return json(res, 200, { driver: drv.publicDriverProfile(d) });
    }

    const drvVehicle = req.method === "PATCH" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/vehicle$/);
    if (drvVehicle) {
      assertDriverSelfOrAdmin(actor, drvVehicle[1]);
      const body = await readBody(req);
      assertAllowedFields(
        body,
        new Set([
          "vehicle_type",
          "vehicle_make",
          "vehicle_model",
          "vehicle_year",
          "vehicle_plate",
          "vehicle_color",
          "license_number",
          "license_expiry",
        ])
      );
      const driver = drv.updateDriverVehicle(drvVehicle[1], body);
      return json(res, 200, { driver });
    }

    const drvOffer = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/offer$/);
    if (drvOffer) {
      assertDriverSelfOrAdmin(actor, drvOffer[1]);
      const offer = drv.getCurrentOffer(drvOffer[1]);
      return json(res, 200, { offer });
    }

    const drvRespond = req.method === "POST" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/offer\/respond$/);
    if (drvRespond) {
      assertDriverSelfOrAdmin(actor, drvRespond[1]);
      const body = await readBody(req);
      const out = drv.respondToOffer(drvRespond[1], Boolean(body.accept));
      return json(res, 200, out);
    }

    const drvJob = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/job$/);
    if (drvJob) {
      assertDriverSelfOrAdmin(actor, drvJob[1]);
      const j = drv.getActiveJob(drvJob[1]);
      return json(res, 200, { active: j });
    }

    const drvRoute = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/route$/);
    if (drvRoute) {
      assertDriverSelfOrAdmin(actor, drvRoute[1]);
      try {
        return json(res, 200, drv.getDriverRouteQueue(drvRoute[1]));
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    const drvPickup = req.method === "POST" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/jobs\/([^/]+)\/confirm-pickup$/);
    if (drvPickup) {
      assertDriverSelfOrAdmin(actor, drvPickup[1]);
      const job = drv.confirmPickup(drvPickup[1], drvPickup[2]);
      return json(res, 200, { job });
    }

    const drvDrop = req.method === "POST" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/jobs\/([^/]+)\/confirm-delivery$/);
    if (drvDrop) {
      assertDriverSelfOrAdmin(actor, drvDrop[1]);
      const body = await readBody(req);
      const out = drv.confirmDelivery(drvDrop[1], drvDrop[2], body);
      return json(res, 200, out);
    }

    const drvEarn = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/earnings$/);
    if (drvEarn) {
      assertDriverSelfOrAdmin(actor, drvEarn[1]);
      const e = drv.getDriverEarnings(drvEarn[1]);
      if (!e) return json(res, 404, { error: "not found" });
      return json(res, 200, e);
    }

    const drvHist = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/history$/);
    if (drvHist) {
      assertDriverSelfOrAdmin(actor, drvHist[1]);
      return json(res, 200, { trips: drv.getDriverHistory(drvHist[1]) });
    }

    const drvPerf = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/performance$/);
    if (drvPerf) {
      requireRole(actor, ["driver", "admin"]);
      if (actor.role === "driver" && actor.driver_id !== drvPerf[1]) return json(res, 403, { error: "Forbidden" });
      const p = drv.getDriverPerformance(drvPerf[1]);
      if (!p) return json(res, 404, { error: "not found" });
      return json(res, 200, p);
    }

    const drvPay = req.method === "POST" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/payouts$/);
    if (drvPay) {
      assertDriverSelfOrAdmin(actor, drvPay[1]);
      const body = await readBody(req);
      const out = drv.requestDriverPayout(drvPay[1], body);
      return json(res, 201, out);
    }

    const drvPrList = req.method === "GET" && url.pathname.match(/^\/api\/drivers\/([^/]+)\/payment-requests$/);
    if (drvPrList) {
      assertDriverSelfOrAdmin(actor, drvPrList[1]);
      return json(res, 200, { requests: drv.listDriverPaymentRequests(drvPrList[1]) });
    }

    if (req.method === "POST" && url.pathname === "/api/dev/driver-rating" && DEV_TOOLS) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const d = drv.addCustomerRating(String(body.driver_id || "d1"), Number(body.stars || 5));
      return json(res, 200, { driver: d });
    }

    const earnGet = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/earnings$/);
    if (earnGet) {
      const vendorId = earnGet[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const e = getVendorEarnings(vendorId);
      if (!e) return json(res, 404, { error: "vendor not found" });
      const net_after_refunds = Math.round(e.net_earnings_tzs - e.refunds_tzs);
      return json(res, 200, { ...e, net_after_refunds_tzs: net_after_refunds });
    }

    const payPost = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/payouts$/);
    if (payPost) {
      const vendorId = payPost[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      const p = requestPayout(vendorId, body);
      return json(res, 201, { payout: p });
    }

    // Settlement payment requests the admin sends to a vendor (end of shift).
    const prList = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/payment-requests$/);
    if (prList) {
      const vendorId = prList[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      return json(res, 200, { requests: listVendorPaymentRequests(vendorId) });
    }
    const prPay = req.method === "POST" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/payment-requests\/([^/]+)\/pay$/);
    if (prPay) {
      const [, vendorId, reqId] = prPay;
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const body = await readBody(req);
      try {
        const r = markPaymentRequestPaid(reqId, body);
        if (r.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
        return json(res, 200, { request: r });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    const stmtGet = req.method === "GET" && url.pathname.match(/^\/api\/vendors\/([^/]+)\/earnings\/statement$/);
    if (stmtGet) {
      const vendorId = stmtGet[1];
      requireVendorAccess(actor);
      if (actor.role === "vendor" && actor.vendor_id !== vendorId) return json(res, 403, { error: "Forbidden" });
      const month = url.searchParams.get("month");
      try {
        const csv = ledgerStatementCsv(vendorId, month);
        if (!csv) return json(res, 404, { error: "vendor not found" });
        return text(res, 200, csv, "text/csv; charset=utf-8");
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/dev/vendor-refund" && DEV_TOOLS) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      addDemoRefund(String(body.vendor_id || "v1"), body.order_id || null, Number(body.amount_tzs || 0));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/overview") {
      requireRole(actor, ["admin"]);
      return json(res, 200, admin.getOverview());
    }
    if (req.method === "GET" && url.pathname === "/api/admin/map/live") {
      requireRole(actor, ["admin"]);
      return json(res, 200, admin.getLiveMapData());
    }
    if (req.method === "GET" && url.pathname === "/api/admin/zones/pressure") {
      requireRole(actor, ["admin"]);
      return json(res, 200, admin.getZonePressure());
    }
    if (req.method === "GET" && url.pathname === "/api/admin/orders") {
      requireRole(actor, ["admin"]);
      const filters = {
        vendor_id: url.searchParams.get("vendor_id") || undefined,
        driver_id: url.searchParams.get("driver_id") || undefined,
        zone: url.searchParams.get("zone") || undefined,
        bucket: url.searchParams.get("bucket") || undefined,
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
      };
      return json(res, 200, { orders: admin.listOrdersAdmin(filters) });
    }
    const adRe = req.method === "POST" && url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/reassign$/);
    if (adRe) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const job = drv.adminReassignJob(adRe[1], body.driver_id);
      return json(res, 200, { job });
    }
    const adCancel = req.method === "POST" && url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/cancel$/);
    if (adCancel) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const o = getOrder(adCancel[1]);
      if (!o) return json(res, 404, { error: "order not found" });
      const amt = moneySafe(body.refund_amount_tzs, o.total_tzs);
      const r = createRefundRequest({
        order_id: adCancel[1],
        amount_tzs: amt,
        reason: String(body.reason || "Admin cancellation"),
      });
      setRefundRequestStatus(r.id, "approved");
      return json(res, 200, { refund: r });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/drivers") {
      requireRole(actor, ["admin"]);
      return json(res, 200, { drivers: drv.getDriversForAdmin() });
    }
    const adSusp = req.method === "PATCH" && url.pathname.match(/^\/api\/admin\/drivers\/([^/]+)\/suspend$/);
    if (adSusp) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const d = drv.adminSetDriverSuspended(adSusp[1], Boolean(body.suspended));
      return json(res, 200, { driver: d });
    }
    const adFlag = req.method === "POST" && url.pathname.match(/^\/api\/admin\/drivers\/([^/]+)\/flag$/);
    if (adFlag) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const d = drv.adminFlagDriver(adFlag[1], body.flagged !== false);
      return json(res, 200, { driver: d });
    }
    const adDh = req.method === "GET" && url.pathname.match(/^\/api\/admin\/drivers\/([^/]+)\/history$/);
    if (adDh) {
      requireRole(actor, ["admin"]);
      return json(res, 200, { trips: drv.getDriverHistory(adDh[1]) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/vendors") {
      requireRole(actor, ["admin"]);
      return json(res, 200, { vendors: admin.getVendorAdminRows() });
    }
    const adVPause = req.method === "POST" && url.pathname.match(/^\/api\/admin\/vendors\/([^/]+)\/pause$/);
    if (adVPause) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const v = adminPauseVendor(adVPause[1], Boolean(body.paused));
      return json(res, 200, { vendor: v });
    }
    const adVPay = req.method === "GET" && url.pathname.match(/^\/api\/admin\/vendors\/([^/]+)\/payouts$/);
    if (adVPay) {
      requireRole(actor, ["admin"]);
      return json(res, 200, { payouts: getVendorPayoutHistory(adVPay[1]) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/applications") {
      requireRole(actor, ["admin"]);
      // Default admin queue: pending only (rejected are hidden unless status=rejected|all)
      const statusParam = url.searchParams.get("status");
      const status = statusParam === "all" ? undefined : statusParam || "pending";
      return json(res, 200, { applications: listVendorApplications({ status }) });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/driver-applications") {
      requireRole(actor, ["admin"]);
      const statusParam = url.searchParams.get("status");
      const status = statusParam === "all" ? undefined : statusParam || "pending";
      return json(res, 200, { applications: await listDriverApplications({ status }) });
    }
    const adDrvOk = req.method === "POST" && url.pathname.match(/^\/api\/admin\/driver-applications\/([^/]+)\/approve$/);
    if (adDrvOk) {
      requireRole(actor, ["admin"]);
      const out = await approveDriverApplication(adDrvOk[1]);
      notifyDriverApplicationApproved({
        application: out.application,
        driver_id: out.driver.id,
      }).catch((e) => console.error("notify driver approved", e));
      return json(res, 200, out);
    }
    const adDrvNo = req.method === "POST" && url.pathname.match(/^\/api\/admin\/driver-applications\/([^/]+)\/reject$/);
    if (adDrvNo) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["reason"]));
      const app = await rejectDriverApplication(adDrvNo[1], body.reason);
      notifyDriverApplicationRejected({ application: app, reason: app.rejection_reason }).catch((e) =>
        console.error("notify driver rejected", e)
      );
      return json(res, 200, { application: app });
    }
    const adDrvRm = req.method === "DELETE" && url.pathname.match(/^\/api\/admin\/driver-applications\/([^/]+)$/);
    if (adDrvRm) {
      requireRole(actor, ["admin"]);
      try {
        return json(res, 200, await removeDriverApplication(adDrvRm[1]));
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    const adAppOk = req.method === "POST" && url.pathname.match(/^\/api\/admin\/applications\/([^/]+)\/approve$/);
    if (adAppOk) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["name", "email", "phone", "password", "locale"]));
      const out = approveVendorApplication(adAppOk[1]);
      let vendorUser = null;
      let generatedPassword = null;
      if (out.application.user_id) {
        vendorUser = await setUserVendorId(out.application.user_id, out.vendor_id);
      } else {
        generatedPassword = `Vendor!${crypto.randomBytes(5).toString("hex")}`;
        const email = body.email || out.application.contact_email || undefined;
        const phone = body.phone || out.application.contact_phone || undefined;
        if (!email && !phone) {
          throw new Error("Approval requires email or phone for vendor account");
        }
        vendorUser = await createUser({
          role: "vendor",
          name: body.name || out.application.contact_name || out.application.business_name,
          email,
          phone,
          password: body.password || generatedPassword,
          locale: body.locale || "en",
          vendor_id: out.vendor_id,
        });
      }
      notifyVendorApplicationApproved({
        application: out.application,
        vendor_id: out.vendor_id,
        contact_email: vendorUser?.email,
        contact_phone: vendorUser?.phone,
      }).catch((e) => console.error("notify vendor approved", e));
      return json(res, 200, {
        ...out,
        vendor_user: vendorUser,
        generated_password: body.password ? null : generatedPassword,
      });
    }
    const adAppNo = req.method === "POST" && url.pathname.match(/^\/api\/admin\/applications\/([^/]+)\/reject$/);
    if (adAppNo) {
      requireRole(actor, ["admin"]);
      const out = rejectVendorApplication(adAppNo[1]);
      notifyVendorApplicationRejected({
        application: out,
        contact_email: out.contact_email,
        contact_phone: out.contact_phone,
      }).catch((e) => console.error("notify vendor rejected", e));
      return json(res, 200, { application: out });
    }
    const adAppRm = req.method === "DELETE" && url.pathname.match(/^\/api\/admin\/applications\/([^/]+)$/);
    if (adAppRm) {
      requireRole(actor, ["admin"]);
      try {
        return json(res, 200, removeVendorApplication(adAppRm[1]));
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/admin/support/conversations") {
      requireRole(actor, ["admin"]);
      return json(res, 200, {
        conversations: support.listConversationsForAdmin(),
        unread_total: support.adminUnreadTotal(),
      });
    }
    const adSupGet = req.method === "GET" && url.pathname.match(/^\/api\/admin\/support\/conversations\/([^/]+)$/);
    if (adSupGet) {
      requireRole(actor, ["admin"]);
      const thread = support.getConversationForAdmin(adSupGet[1]);
      if (!thread) return json(res, 404, { error: "Conversation not found" });
      await support.markReadForAdmin(adSupGet[1]);
      return json(res, 200, thread);
    }
    const adSupMsg = req.method === "POST" && url.pathname.match(/^\/api\/admin\/support\/conversations\/([^/]+)\/messages$/);
    if (adSupMsg) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["body"]));
      const message = await support.postAdminMessage(adSupMsg[1], actor, body.body);
      return json(res, 201, { message });
    }
    const adSupStatus = req.method === "POST" && url.pathname.match(/^\/api\/admin\/support\/conversations\/([^/]+)\/status$/);
    if (adSupStatus) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      assertAllowedFields(body, new Set(["status"]));
      const conversation = await support.setConversationStatus(adSupStatus[1], String(body.status));
      return json(res, 200, { conversation });
    }

    // Admin: end-of-day vendor + driver payouts (auto amount = that day's net earnings)
    if (req.method === "GET" && url.pathname === "/api/admin/finance/end-of-day") {
      requireRole(actor, ["admin"]);
      const day = url.searchParams.get("day") || utcDayKey();
      const vendors = getEndOfDayFinanceSnapshot(day);
      const driversSnap = drv.getEndOfDayDriverFinanceSnapshot(day);
      return json(res, 200, {
        ...vendors,
        drivers: driversSnap.drivers,
        driver_requests: driversSnap.requests,
        driver_totals: driversSnap.totals,
        payout_mpesa: getPayoutMpesaSummary(),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/finance/end-of-day/generate") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req).catch(() => ({}));
      const day = String(body?.day || url.searchParams.get("day") || utcDayKey()).slice(0, 10);
      const vendors = generateEndOfDayVendorPayoutRequests(day);
      const driversOut = drv.generateEndOfDayDriverPayoutRequests(day);
      return json(res, 200, {
        day_key: day,
        created: [...(vendors.created || []), ...(driversOut.created || [])],
        skipped: [...(vendors.skipped || []), ...(driversOut.skipped || [])],
        vendors: vendors.vendors,
        requests: vendors.requests,
        drivers: driversOut.drivers,
        driver_requests: driversOut.requests,
        vendor_created: vendors.created,
        driver_created: driversOut.created,
      });
    }
    const adPrPayOut =
      req.method === "POST" && url.pathname.match(/^\/api\/admin\/payment-requests\/([^/]+)\/pay-out$/);
    if (adPrPayOut) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req).catch(() => ({}));
      try {
        if (drv.getDriverPaymentRequest(adPrPayOut[1])) {
          const out = drv.payDriverEndOfDayRequest(adPrPayOut[1], body || {});
          return json(res, 200, out);
        }
        const out = payVendorEndOfDayRequest(adPrPayOut[1], body || {});
        return json(res, 200, out);
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    // Admin: list settlement / payout payment requests
    if (req.method === "GET" && url.pathname === "/api/admin/payment-requests") {
      requireRole(actor, ["admin"]);
      return json(res, 200, {
        requests: [...listAllPaymentRequests(), ...drv.listAllDriverPaymentRequests()],
      });
    }
    const adPrCreate = req.method === "POST" && url.pathname.match(/^\/api\/admin\/vendors\/([^/]+)\/payment-requests$/);
    if (adPrCreate) {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      try {
        const r = createVendorPaymentRequest(adPrCreate[1], body);
        return json(res, 201, { request: r });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    const adPrCancel = req.method === "POST" && url.pathname.match(/^\/api\/admin\/payment-requests\/([^/]+)\/cancel$/);
    if (adPrCancel) {
      requireRole(actor, ["admin"]);
      try {
        if (drv.getDriverPaymentRequest(adPrCancel[1])) {
          return json(res, 200, { request: drv.cancelDriverPaymentRequest(adPrCancel[1]) });
        }
        return json(res, 200, { request: cancelPaymentRequest(adPrCancel[1]) });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/admin/finance/summary") {
      requireRole(actor, ["admin"]);
      return json(res, 200, admin.getFinanceSummary());
    }
    if (req.method === "POST" && url.pathname === "/api/admin/finance/vendor-payout") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const p = admin.adminTriggerVendorPayout(body.vendor_id, body);
      return json(res, 201, { payout: p });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/finance/driver-payout") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const out = admin.adminTriggerDriverPayout(body.driver_id, body);
      return json(res, 201, out);
    }
    if (req.method === "GET" && url.pathname === "/api/admin/finance/commission") {
      requireRole(actor, ["admin"]);
      return json(res, 200, getCommissionSettings());
    }
    if (req.method === "PATCH" && url.pathname === "/api/admin/finance/commission") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const out = setCommissionForCategory(body.category_id, body.bps);
      return json(res, 200, out);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/settings/mpesa") {
      requireRole(actor, ["admin"]);
      return json(res, 200, { settings: getMpesaSettings({ baseUrl: requestBaseUrl(req) }) });
    }
    if (req.method === "PATCH" && url.pathname === "/api/admin/settings/mpesa") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      updateMpesaSettings(body, { actorId: actor.id });
      return json(res, 200, { settings: getMpesaSettings({ baseUrl: requestBaseUrl(req) }) });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/settings/mpesa/test") {
      requireRole(actor, ["admin"]);
      const validation = validateMpesaConfig();
      return json(res, 200, {
        ok: validation.ok,
        validation,
        checkout_available: isMpesaCheckoutEnabled(),
        wallet_env_gate_open: isWalletEnvGateOpen(),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/settings/bank") {
      requireRole(actor, ["admin"]);
      return json(res, 200, { settings: getBankSettings() });
    }
    if (req.method === "PATCH" && url.pathname === "/api/admin/settings/bank") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      updateBankSettings(body, { actorId: actor.id });
      return json(res, 200, { settings: getBankSettings() });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/settings/payout-mpesa") {
      requireRole(actor, ["admin"]);
      return json(res, 200, { settings: getPayoutMpesaSettings(), summary: getPayoutMpesaSummary() });
    }
    if (req.method === "PATCH" && url.pathname === "/api/admin/settings/payout-mpesa") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      try {
        const settings = updatePayoutMpesaSettings(body, { actorId: actor.id });
        return json(res, 200, { settings, summary: getPayoutMpesaSummary() });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/admin/settings/delivery-cities") {
      requireRole(actor, ["admin"]);
      return json(res, 200, getDeliveryCitiesMeta());
    }
    if (req.method === "POST" && url.pathname === "/api/admin/settings/delivery-cities") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      try {
        const city = addDeliveryCity(body || {}, { actorId: actor.id });
        return json(res, 201, { city, ...getDeliveryCitiesMeta() });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    const adCityDel =
      req.method === "DELETE" && url.pathname.match(/^\/api\/admin\/settings\/delivery-cities\/([^/]+)$/);
    if (adCityDel) {
      requireRole(actor, ["admin"]);
      try {
        const out = removeDeliveryCity(decodeURIComponent(adCityDel[1]), { actorId: actor.id });
        return json(res, 200, { ...out, ...getDeliveryCitiesMeta() });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/admin/settings/delivery-cities/reset") {
      requireRole(actor, ["admin"]);
      return json(res, 200, resetDeliveryCities({ actorId: actor.id }));
    }

    if (req.method === "GET" && url.pathname === "/api/admin/refunds") {
      requireRole(actor, ["admin"]);
      return json(res, 200, { refunds: listRefundRequests() });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/refunds") {
      requireRole(actor, ["admin"]);
      const body = await readBody(req);
      const r = createRefundRequest(body);
      return json(res, 201, { refund: r });
    }
    const adRefOk = req.method === "POST" && url.pathname.match(/^\/api\/admin\/refunds\/([^/]+)\/approve$/);
    if (adRefOk) {
      requireRole(actor, ["admin"]);
      const r = setRefundRequestStatus(adRefOk[1], "approved");
      return json(res, 200, { refund: r });
    }
    const adRefNo = req.method === "POST" && url.pathname.match(/^\/api\/admin\/refunds\/([^/]+)\/reject$/);
    if (adRefNo) {
      requireRole(actor, ["admin"]);
      const r = setRefundRequestStatus(adRefNo[1], "rejected");
      return json(res, 200, { refund: r });
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith("Invalid transition")) {
      return json(res, 409, { error: msg });
    }
    if (msg === "Authentication required") {
      return json(res, 401, { error: msg });
    }
    if (msg === "Forbidden") {
      return json(res, 403, { error: msg });
    }
    if (msg === "Payload too large") {
      return json(res, 413, { error: msg });
    }
    return json(res, 400, { error: msg });
  }
});

process.on("unhandledRejection", (err) => {
  // eslint-disable-next-line no-console
  console.warn("[garden] Unhandled promise rejection:", err?.message || err);
});

authReady
  .then(() => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // eslint-disable-next-line no-console
        console.error(
          `Port ${PORT} is already in use. Run: npm run dev (auto-frees port) or set PORT=3781 in .env`
        );
        process.exit(1);
      }
      throw err;
    });

    function shutdown() {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    }
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    const host = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
    server.listen(PORT, host, () => {
      // eslint-disable-next-line no-console
      console.log(`garden listening on http://${host}:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to initialize auth storage", err);
    process.exit(1);
  });
