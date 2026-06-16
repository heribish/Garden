import * as drv from "./drivers.js";
import {
  countVendorProducts,
  getAllOrders,
  getCommissionSettings,
  getLedger,
  getVendorEarnings,
  getVendorPayoutHistory,
  listAllVendors,
  listVendorApplications,
  requestPayout,
  setCommissionForCategory,
} from "./store.js";

const platformAuditLog = [];

const TARGETS = {
  min_orders_today: 15,
  min_drivers_online: 2,
  max_avg_delivery_min: 55,
  min_revenue_vs_yesterday_ratio: 0.75,
};

function iso(d = new Date()) {
  return d.toISOString();
}

function startUtc(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function inferZone(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "Unknown";
  if (lng > 39.28) return "Msasani";
  if (lat < -6.83) return "Temeke";
  if (lng < 39.18) return "Ubungo";
  return "Central";
}

export function adminOrderBucket(status) {
  if (["placed", "payment_pending", "paid", "new"].includes(status)) return "pending";
  if (status === "preparing") return "preparing";
  if (["ready_for_pickup", "driver_en_route_pickup", "driver_en_route_delivery"].includes(status)) return "on_the_way";
  if (status === "delivered") return "delivered";
  if (["declined", "cancelled"].includes(status)) return "cancelled";
  return status;
}

function ordersBetween(orders, from, to) {
  return orders.filter((o) => {
    const t = new Date(o.created_at);
    return t >= from && t < to;
  });
}

function grossRevenueForDay(ledgerRows, dayStart) {
  const next = new Date(dayStart);
  next.setUTCDate(next.getUTCDate() + 1);
  let g = 0;
  for (const l of ledgerRows) {
    if (l.type !== "sale") continue;
    const t = new Date(l.created_at);
    if (t >= dayStart && t < next) g += l.gross_tzs;
  }
  return g;
}

function avgDeliveryMinutesToday(orders) {
  const today = startUtc(new Date());
  const next = new Date(today);
  next.setUTCDate(next.getUTCDate() + 1);
  const samples = [];
  for (const o of orders) {
    if (o.status !== "delivered" || !o.dispatch_ready_at || !o.delivered_at) continue;
    const end = new Date(o.delivered_at);
    if (end < today || end >= next) continue;
    const start = new Date(o.dispatch_ready_at);
    samples.push((end - start) / 60000);
  }
  if (!samples.length) return null;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

export function getOverview() {
  const now = new Date();
  const today = startUtc(now);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const orders = getAllOrders();
  const ledgerRows = getLedger();
  const ordersToday = ordersBetween(orders, today, tomorrow).length;
  const ordersYesterday = ordersBetween(orders, yesterday, today).length;
  const revenueToday = grossRevenueForDay(ledgerRows, today);
  const revenueYesterday = grossRevenueForDay(ledgerRows, yesterday);

  const driverRows = drv.getDriversForAdmin();
  const driversOnline = driverRows.filter((d) => d.admin_ui_status === "online").length;
  const avgDel = avgDeliveryMinutesToday(orders);

  const alerts = [];
  if (ordersToday < TARGETS.min_orders_today) {
    alerts.push({ level: "red", code: "orders_low", message: `Orders today (${ordersToday}) below target (${TARGETS.min_orders_today})` });
  }
  if (driversOnline < TARGETS.min_drivers_online) {
    alerts.push({ level: "red", code: "drivers_low", message: `Only ${driversOnline} drivers online (target ≥ ${TARGETS.min_drivers_online})` });
  }
  if (avgDel != null && avgDel > TARGETS.max_avg_delivery_min) {
    alerts.push({ level: "red", code: "sla_slow", message: `Avg delivery today ~${avgDel} min (target < ${TARGETS.max_avg_delivery_min})` });
  }
  if (revenueYesterday > 0 && revenueToday / revenueYesterday < TARGETS.min_revenue_vs_yesterday_ratio) {
    alerts.push({
      level: "red",
      code: "revenue_dip",
      message: `Gross revenue today vs yesterday: ${Math.round((revenueToday / revenueYesterday) * 100)}% (watch for < ${Math.round(TARGETS.min_revenue_vs_yesterday_ratio * 100)}%)`,
    });
  }

  return {
    generated_at: iso(now),
    today: {
      orders: ordersToday,
      gross_revenue_tzs: revenueToday,
      drivers_online: driversOnline,
      avg_delivery_minutes: avgDel,
    },
    yesterday: {
      orders: ordersYesterday,
      gross_revenue_tzs: revenueYesterday,
    },
    targets: TARGETS,
    alerts,
  };
}

export function getLiveMapData() {
  const drivers = drv.getDriversForAdmin();
  const pins = [];
  const orders = getAllOrders();
  for (const o of orders) {
    if (["ready_for_pickup", "driver_en_route_pickup", "driver_en_route_delivery"].includes(o.status)) {
      const job = drv.findJobByOrderId(o.id);
      if (job?.pickup) {
        pins.push({
          kind: "pickup",
          order_id: o.id,
          lat: job.pickup.lat,
          lng: job.pickup.lng,
          label: job.pickup.label,
        });
      }
      if (job?.dropoff) {
        pins.push({
          kind: "dropoff",
          order_id: o.id,
          lat: job.dropoff.lat,
          lng: job.dropoff.lng,
          label: job.dropoff.label,
        });
      }
    }
  }
  return {
    drivers: drivers.map((d) => ({
      id: d.id,
      name: d.name,
      lat: d.lat,
      lng: d.lng,
      online: d.online,
      suspended: d.suspended,
      status: d.admin_ui_status,
      vehicle_type: d.vehicle_type,
      zone: inferZone(d.lat, d.lng),
    })),
    pins,
  };
}

export function getZonePressure() {
  const mapData = getLiveMapData();
  const zoneDrivers = {};
  for (const d of mapData.drivers) {
    if (d.status !== "online") continue;
    zoneDrivers[d.zone] = (zoneDrivers[d.zone] || 0) + 1;
  }
  const zoneJobs = {};
  for (const p of mapData.pins) {
    if (p.kind !== "pickup") continue;
    const z = inferZone(p.lat, p.lng);
    zoneJobs[z] = (zoneJobs[z] || 0) + 1;
  }
  const zones = new Set([...Object.keys(zoneDrivers), ...Object.keys(zoneJobs)]);
  const rows = [];
  for (const z of zones) {
    const jd = zoneJobs[z] || 0;
    const dr = zoneDrivers[z] || 0;
    const pressure = jd > 0 && dr < jd ? "high" : jd > 0 && dr < jd * 2 ? "medium" : "ok";
    rows.push({
      zone: z,
      active_pickups: jd,
      online_drivers: dr,
      pressure,
      suggest_push: pressure !== "ok",
    });
  }
  return { zones: rows };
}

export function listOrdersAdmin(filters = {}) {
  let rows = getAllOrders().map((o) => {
    const job = drv.findJobByOrderId(o.id);
    return {
      ...o,
      admin_bucket: adminOrderBucket(o.status),
      zone: inferZone(o.dropoff_lat, o.dropoff_lng),
      driver_id: job?.driver_id || null,
      job_status: job?.status || null,
    };
  });
  if (filters.vendor_id) rows = rows.filter((o) => o.vendor_id === filters.vendor_id);
  if (filters.driver_id) rows = rows.filter((o) => o.driver_id === filters.driver_id);
  if (filters.zone) rows = rows.filter((o) => o.zone === filters.zone);
  if (filters.bucket) rows = rows.filter((o) => o.admin_bucket === filters.bucket);
  if (filters.from) {
    const f = new Date(filters.from);
    rows = rows.filter((o) => new Date(o.created_at) >= f);
  }
  if (filters.to) {
    const t = new Date(filters.to);
    rows = rows.filter((o) => new Date(o.created_at) <= t);
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return rows;
}

export function getFinanceSummary() {
  const ledgerRows = getLedger();
  let platformFees = 0;
  for (const l of ledgerRows) {
    if (l.type === "sale") platformFees += l.fee_tzs;
  }
  let vendorOwed = 0;
  for (const v of listAllVendors()) {
    const e = getVendorEarnings(v.id);
    if (e) vendorOwed += e.available_balance_tzs;
  }
  let driverOwed = 0;
  for (const d of drv.listDrivers()) {
    const e = drv.getDriverEarnings(d.id);
    if (e) driverOwed += e.available_balance_tzs;
  }
  return {
    platform_fees_collected_tzs: platformFees,
    vendor_balances_owed_tzs: vendorOwed,
    driver_balances_owed_tzs: driverOwed,
    commission_settings: getCommissionSettings(),
    audit_log_tail: platformAuditLog.slice(-25),
  };
}

export function adminProcessPayoutNote(entry) {
  platformAuditLog.push({ ...entry, at: iso(new Date()) });
  return entry;
}

export function adminTriggerVendorPayout(vendorId, body) {
  const p = requestPayout(vendorId, body);
  adminProcessPayoutNote({ type: "vendor_payout", vendor_id: vendorId, payout_id: p.id, amount_tzs: p.amount_tzs });
  return p;
}

export function adminTriggerDriverPayout(driverId, body) {
  const out = drv.requestDriverPayout(driverId, body);
  adminProcessPayoutNote({ type: "driver_payout", driver_id: driverId, amount_tzs: body.amount_tzs });
  return out;
}

export function getVendorAdminRows() {
  return listAllVendors().map((v) => {
    const e = getVendorEarnings(v.id);
    return {
      id: v.id,
      name: v.name,
      zone: v.zone || "—",
      shop_open: v.shop_open,
      admin_paused: Boolean(v.admin_paused),
      rating_avg: v.rating_avg,
      rating_count: v.rating_count,
      active_products: countVendorProducts(v.id),
      available_balance_tzs: e?.available_balance_tzs ?? 0,
      gross_sales_tzs: e?.gross_sales_tzs ?? 0,
    };
  });
}
