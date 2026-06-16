import crypto from "node:crypto";
import { transitionOrder } from "./orderMachine.js";
import { appendLedgerSale, getAllOrders, getOrder, getVendor } from "./store.js";

export const OFFER_SECONDS = 30;

const drivers = new Map();
const jobs = new Map();
const driverLedger = [];

function iso(d = new Date()) {
  return d.toISOString();
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
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function mkOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function seedDrivers() {
  const mk = (id, name) => ({
    id,
    name,
    phone: "255744000000",
    online: false,
    lat: -6.79,
    lng: 39.2,
    last_seen_at: iso(),
    rating_avg: id === "d1" ? 4.85 : 4.5,
    rating_count: 263,
    stars: { 5: 210, 4: 42, 3: 8, 2: 2, 1: 1 },
    offers_received: 120,
    offers_accepted: 100,
    offers_declined: 8,
    offer_timeouts: 12,
    deliveries_completed: 98,
    on_time: 91,
    late: 7,
    vehicle_type: id === "d1" ? "Motorbike" : "Bicycle",
    suspended: false,
    flagged_for_review: false,
    complaint_count: id === "d2" ? 2 : 0,
  });
  drivers.set("d1", mk("d1", "Driver One"));
  drivers.set("d2", mk("d2", "Driver Two"));

  const now = new Date();
  for (let day = 6; day >= 0; day--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - day);
    for (let i = 0; i < 3 + (day % 3); i++) {
      driverLedger.push({
        id: `dled_seed_${day}_${i}`,
        driver_id: "d1",
        type: "delivery_fee",
        amount_tzs: money(4000 + (i % 4) * 500),
        created_at: iso(d),
        meta: { label: "Seed trip" },
      });
    }
  }
}

seedDrivers();

export function getDriver(id) {
  return drivers.get(id);
}

/** Create a driver record when someone signs up as a driver. */
export function provisionDriverForSignup({ name, phone }) {
  const id = `d_${crypto.randomBytes(3).toString("hex")}`;
  const row = {
    id,
    name: String(name || "Driver").trim() || "Driver",
    phone: String(phone || "255744000000").replace(/\D/g, "") || "255744000000",
    online: false,
    lat: -6.79,
    lng: 39.2,
    last_seen_at: iso(),
    rating_avg: 0,
    rating_count: 0,
    stars: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
    offers_received: 0,
    offers_accepted: 0,
    offers_declined: 0,
    offer_timeouts: 0,
    deliveries_completed: 0,
    on_time: 0,
    late: 0,
    vehicle_type: "Motorbike",
    suspended: false,
    flagged_for_review: false,
    complaint_count: 0,
  };
  drivers.set(id, row);
  return row;
}

export function setDriverVehicleMeta(driverId, meta) {
  const d = drivers.get(driverId);
  if (!d) return null;
  d.verification = {
    plate: meta.plate || null,
    color: meta.color || null,
    license_number: meta.license_number || null,
    license_expiry: meta.license_expiry || null,
    national_id: meta.national_id || null,
    verified_at: meta.verified_at || iso(),
  };
  if (meta.plate) d.vehicle_plate = meta.plate;
  return d;
}

export function listDrivers() {
  return [...drivers.values()];
}

export function getDriversForAdmin() {
  return [...drivers.values()].map((d) => ({
    id: d.id,
    name: d.name,
    phone: d.phone,
    online: d.online,
    suspended: d.suspended,
    flagged_for_review: d.flagged_for_review,
    complaint_count: d.complaint_count,
    rating_avg: d.rating_avg,
    vehicle_type: d.vehicle_type,
    lat: d.lat,
    lng: d.lng,
    last_seen_at: d.last_seen_at,
    admin_ui_status: d.suspended ? "suspended" : hasActiveDeliveryJob(d.id) ? "delivering" : d.online ? "online" : "offline",
  }));
}

function driverAcceptanceRate(d) {
  const denom = d.offers_accepted + d.offers_declined + d.offer_timeouts;
  if (!denom) return 1;
  return d.offers_accepted / denom;
}

function driverOnTimePct(d) {
  const t = d.on_time + d.late;
  if (!t) return 1;
  return d.on_time / t;
}

/** Higher = better priority when assigning offers */
export function driverPriorityScore(d, distanceToPickupKm) {
  const acc = driverAcceptanceRate(d);
  const ot = driverOnTimePct(d);
  return d.rating_avg * 40 + acc * 35 + ot * 25 - distanceToPickupKm * 3;
}

function hasActiveDeliveryJob(driverId) {
  for (const job of jobs.values()) {
    if (job.driver_id !== driverId) continue;
    if (job.status === "active_pickup" || job.status === "active_delivery") return true;
  }
  return false;
}

function rankDriversForPickup(pickupLat, pickupLng) {
  const online = [...drivers.values()].filter(
    (d) =>
      d.online &&
      !d.suspended &&
      Number.isFinite(d.lat) &&
      Number.isFinite(d.lng) &&
      !hasActiveDeliveryJob(d.id)
  );
  return online
    .map((d) => ({
      d,
      dist: haversineKm(d.lat, d.lng, pickupLat, pickupLng),
      score: driverPriorityScore(d, haversineKm(d.lat, d.lng, pickupLat, pickupLng)),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d);
}

function clearJobTimer(job) {
  if (job._timer) {
    clearTimeout(job._timer);
    job._timer = null;
  }
}

function estimateEarnings(distanceKm) {
  return money(3200 + Math.min(25, Math.max(0, distanceKm)) * 420);
}

function estimateEtaMin(distanceKm, avgKmh = 22) {
  return Math.max(4, Math.round((distanceKm / avgKmh) * 60));
}

export function setDriverOnline(driverId, online, lat, lng) {
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  if (d.suspended && online) throw new Error("Driver account suspended");
  d.online = Boolean(online);
  if (lat != null && lng != null) {
    d.lat = Number(lat);
    d.lng = Number(lng);
  }
  d.last_seen_at = iso();
  if (d.online) {
    for (const job of jobs.values()) {
      if (job.status === "waiting_drivers" || job.status === "no_driver_available") {
        if (job.status === "no_driver_available") job.pointer = 0;
        job.status = "waiting_drivers";
        scheduleOfferRound(job.id);
      }
    }
  }
  return d;
}

export function setDriverLocation(driverId, lat, lng) {
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  d.lat = Number(lat);
  d.lng = Number(lng);
  d.last_seen_at = iso();
  return d;
}

export function startDispatchForOrder(order) {
  if (!order || order.delivery_job_id) return null;
  const v = getVendor(order.vendor_id);
  if (!v) return null;
  const pickupLat = v.pickup_lat;
  const pickupLng = v.pickup_lng;
  const dropLat = order.dropoff_lat;
  const dropLng = order.dropoff_lng;
  const distShopToCust = haversineKm(pickupLat, pickupLng, dropLat, dropLng);
  const otp = mkOtp();
  order.delivery_otp = otp;
  const jobId = `job_${crypto.randomBytes(6).toString("hex")}`;
  const earnings = estimateEarnings(distShopToCust + 1);
  const job = {
    id: jobId,
    order_id: order.id,
    vendor_id: order.vendor_id,
    status: "waiting_drivers",
    driver_id: null,
    offered_driver_id: null,
    offer_expires_at: null,
    offer_generation: 0,
    pointer: 0,
    pickup: { lat: pickupLat, lng: pickupLng, label: v.pickup_label || "Shop" },
    dropoff: { lat: dropLat, lng: dropLng, label: order.dropoff_label || "Customer" },
    distance_shop_customer_km: Math.round(distShopToCust * 100) / 100,
    eta_shop_to_customer_min: estimateEtaMin(distShopToCust),
    earnings_tzs: earnings,
    created_at: iso(),
    promised_delivery_at: null,
    pickup_confirmed_at: null,
    delivery_confirmed_at: null,
    on_time: null,
    _timer: null,
  };
  jobs.set(jobId, job);
  order.delivery_job_id = jobId;
  scheduleOfferRound(jobId);
  return job;
}

function scheduleOfferRound(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status === "completed" || job.status === "cancelled" || job.driver_id) return;

  clearJobTimer(job);
  const ranked = rankDriversForPickup(job.pickup.lat, job.pickup.lng);

  if (!ranked.length) {
    job.status = "waiting_drivers";
    job.offered_driver_id = null;
    return;
  }

  if (job.pointer >= ranked.length) {
    job.status = "no_driver_available";
    return;
  }

  const nextDriver = ranked[job.pointer];
  if (!nextDriver || !nextDriver.online) {
    job.pointer += 1;
    scheduleOfferRound(jobId);
    return;
  }

  job.status = "offered";
  job.offered_driver_id = nextDriver.id;
  job.offer_generation += 1;
  const gen = job.offer_generation;
  const exp = new Date(Date.now() + OFFER_SECONDS * 1000);
  job.offer_expires_at = iso(exp);

  job._timer = setTimeout(() => {
    expireOfferIfStale(jobId, gen, nextDriver.id);
  }, OFFER_SECONDS * 1000);
}

function expireOfferIfStale(jobId, generation, driverId) {
  const job = jobs.get(jobId);
  if (!job || job.offer_generation !== generation || job.offered_driver_id !== driverId) return;
  if (job.status !== "offered") return;
  const d = drivers.get(driverId);
  if (d) d.offer_timeouts += 1;
  job.pointer += 1;
  job.offered_driver_id = null;
  job.offer_expires_at = null;
  job.status = "waiting_drivers";
  clearJobTimer(job);
  scheduleOfferRound(jobId);
}

export function getCurrentOffer(driverId) {
  const d = drivers.get(driverId);
  if (!d || !d.online || hasActiveDeliveryJob(driverId)) return null;
  for (const job of jobs.values()) {
    if (job.status !== "offered" || job.offered_driver_id !== driverId) continue;
    if (job.offer_expires_at && new Date(job.offer_expires_at) < new Date()) continue;
    const distToPickup = haversineKm(d.lat, d.lng, job.pickup.lat, job.pickup.lng);
    const etaToPickupMin = estimateEtaMin(distToPickup, 18);
    return {
      job_id: job.id,
      order_id: job.order_id,
      expires_at: job.offer_expires_at,
      seconds_left: Math.max(0, Math.round((new Date(job.offer_expires_at) - Date.now()) / 1000)),
      pickup: job.pickup,
      dropoff: job.dropoff,
      distance_shop_customer_km: job.distance_shop_customer_km,
      eta_shop_to_customer_min: job.eta_shop_to_customer_min,
      distance_to_pickup_km: Math.round(distToPickup * 100) / 100,
      eta_to_pickup_min: etaToPickupMin,
      earnings_tzs: job.earnings_tzs,
    };
  }
  return null;
}

export function respondToOffer(driverId, accept) {
  const job = [...jobs.values()].find(
    (j) => j.status === "offered" && j.offered_driver_id === driverId && j.offer_expires_at && new Date(j.offer_expires_at) >= new Date()
  );
  if (!job) throw new Error("No active offer");
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  if (hasActiveDeliveryJob(driverId)) throw new Error("Finish your active delivery before accepting a new offer");
  clearJobTimer(job);
  d.offers_received += 1;
  if (!accept) {
    d.offers_declined += 1;
    job.pointer += 1;
    job.offered_driver_id = null;
    job.offer_expires_at = null;
    job.status = "waiting_drivers";
    scheduleOfferRound(job.id);
    return { ok: true, declined: true };
  }
  d.offers_accepted += 1;
  job.driver_id = driverId;
  job.offered_driver_id = null;
  job.offer_expires_at = null;
  job.status = "active_pickup";
  const order = getOrder(job.order_id);
  if (order) transitionOrder(order, "driver_en_route_pickup");
  return { ok: true, job };
}

/** Start driver dispatch for orders vendors marked ready (idempotent). */
export function ensureDispatchForReadyOrders() {
  for (const order of getAllOrders()) {
    if (order.status === "ready_for_pickup" && !order.delivery_job_id) {
      startDispatchForOrder(order);
    }
  }
}

/**
 * Ordered stops for the driver map: active job legs first, then nearby open jobs by GPS distance to pickup.
 */
export function getDriverRouteQueue(driverId) {
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  const truck = {
    lat: d.lat,
    lng: d.lng,
    label: d.name || "Truck",
    updated_at: d.last_seen_at,
  };

  const stops = [];
  let seq = 0;
  const active = getActiveJob(driverId);

  if (active?.job) {
    const pickupStop = {
      seq: ++seq,
      leg: "pickup",
      order_id: active.order?.id,
      job_id: active.job.id,
      label: active.shop_name || active.job.pickup?.label || "Shop pickup",
      lat: active.job.pickup.lat,
      lng: active.job.pickup.lng,
      status: active.job.status === "active_pickup" ? "current" : "done",
      distance_km:
        active.job.status === "active_pickup" && active.distance_to_target_km != null
          ? active.distance_to_target_km
          : Math.round(haversineKm(d.lat, d.lng, active.job.pickup.lat, active.job.pickup.lng) * 100) / 100,
      eta_min:
        active.job.status === "active_pickup"
          ? estimateEtaMin(
              haversineKm(d.lat, d.lng, active.job.pickup.lat, active.job.pickup.lng),
              18
            )
          : null,
    };
    const dropDist = haversineKm(d.lat, d.lng, active.job.dropoff.lat, active.job.dropoff.lng);
    const dropStop = {
      seq: ++seq,
      leg: "dropoff",
      order_id: active.order?.id,
      job_id: active.job.id,
      label: active.order?.dropoff_label || active.job.dropoff?.label || "Customer",
      lat: active.job.dropoff.lat,
      lng: active.job.dropoff.lng,
      customer_name: active.order?.customer_name,
      status: active.job.status === "active_delivery" ? "current" : "pending",
      distance_km:
        active.job.status === "active_delivery" && active.distance_to_target_km != null
          ? active.distance_to_target_km
          : Math.round(dropDist * 100) / 100,
      eta_min:
        active.job.status === "active_delivery"
          ? estimateEtaMin(dropDist, 22)
          : estimateEtaMin(
              haversineKm(active.job.pickup.lat, active.job.pickup.lng, active.job.dropoff.lat, active.job.dropoff.lng),
              22
            ),
    };

    if (active.job.status === "active_pickup") {
      stops.push(pickupStop, dropStop);
    } else {
      stops.push({ ...dropStop, seq: 1 });
    }
  }

  ensureDispatchForReadyOrders();

  const upcoming = [];
  const busy = Boolean(active?.job);
  for (const job of jobs.values()) {
    if (["completed", "cancelled", "active_pickup", "active_delivery"].includes(job.status)) continue;
    if (job.driver_id && job.driver_id !== driverId) continue;
    if (busy) continue;
    const order = getOrder(job.order_id);
    if (!order) continue;
    const distPickup = haversineKm(d.lat, d.lng, job.pickup.lat, job.pickup.lng);
    upcoming.push({
      job_id: job.id,
      order_id: job.order_id,
      status: job.status,
      customer_name: order.customer_name,
      pickup_label: job.pickup?.label || "Shop",
      dropoff_label: job.dropoff?.label || order.dropoff_label || "Customer",
      pickup: job.pickup,
      dropoff: job.dropoff,
      distance_to_pickup_km: Math.round(distPickup * 100) / 100,
      eta_to_pickup_min: estimateEtaMin(distPickup, 18),
      earnings_tzs: job.earnings_tzs,
    });
  }
  upcoming.sort((a, b) => a.distance_to_pickup_km - b.distance_to_pickup_km);
  upcoming.forEach((row, i) => {
    row.queue_position = i + 1;
  });

  let hint = null;
  if (!stops.length && !upcoming.length) {
    if (!d.online) hint = "offline";
    else if (busy) hint = "on_delivery";
    else hint = "waiting_for_orders";
  }

  return {
    truck,
    stops,
    upcoming,
    active_phase: active?.phase || null,
    hint,
  };
}

export function getActiveJob(driverId) {
  for (const job of jobs.values()) {
    if (job.driver_id !== driverId) continue;
    if (job.status !== "active_pickup" && job.status !== "active_delivery") continue;
    const order = getOrder(job.order_id);
    const d = drivers.get(driverId);
    const target = job.status === "active_pickup" ? job.pickup : job.dropoff;
    const dist = d ? haversineKm(d.lat, d.lng, target.lat, target.lng) : null;
    const v = order ? getVendor(order.vendor_id) : null;
    return {
      job,
      order,
      phase: job.status === "active_pickup" ? "to_shop" : "to_customer",
      target,
      distance_to_target_km: dist == null ? null : Math.round(dist * 100) / 100,
      delivery_otp: order?.delivery_otp || null,
      shop_phone: v?.shop_phone || null,
      shop_name: v?.name || null,
    };
  }
  return null;
}

export function confirmPickup(driverId, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.driver_id !== driverId) throw new Error("Job not found");
  if (job.status !== "active_pickup") throw new Error("Invalid job state");
  job.status = "active_delivery";
  job.pickup_confirmed_at = iso();
  const deadline = new Date(Date.now() + 45 * 60 * 1000);
  job.promised_delivery_at = iso(deadline);
  const order = getOrder(job.order_id);
  if (order) transitionOrder(order, "driver_en_route_delivery");
  return job;
}

export function confirmDelivery(driverId, jobId, { proof_type, otp, photo_data_url }) {
  const job = jobs.get(jobId);
  if (!job || job.driver_id !== driverId) throw new Error("Job not found");
  if (job.status !== "active_delivery") throw new Error("Invalid job state");
  const order = getOrder(job.order_id);
  if (!order) throw new Error("Order not found");
  if (proof_type === "otp") {
    if (String(otp || "").trim() !== String(order.delivery_otp)) throw new Error("Invalid OTP");
  } else if (proof_type === "photo") {
    if (!photo_data_url || String(photo_data_url).length < 40) throw new Error("Photo required");
  } else {
    throw new Error("proof_type must be otp or photo");
  }
  job.status = "completed";
  job.delivery_confirmed_at = iso();
  const onTime = job.promised_delivery_at ? new Date() <= new Date(job.promised_delivery_at) : true;
  job.on_time = onTime;
  const drv = drivers.get(driverId);
  if (drv) {
    drv.deliveries_completed += 1;
    if (onTime) drv.on_time += 1;
    else drv.late += 1;
  }
  transitionOrder(order, "delivered");
  order.delivered_at = iso(new Date());
  appendLedgerSale(order.vendor_id, order.id, order.total_tzs, iso(new Date()));
  driverLedger.push({
    id: `dled_${crypto.randomBytes(5).toString("hex")}`,
    driver_id: driverId,
    type: "delivery_fee",
    amount_tzs: job.earnings_tzs,
    created_at: iso(),
    meta: { order_id: order.id, job_id: job.id },
  });
  return { job, order, on_time: onTime };
}

export function getDriverEarnings(driverId) {
  const feeRows = driverLedger.filter((l) => l.driver_id === driverId && l.type === "delivery_fee");
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  let today = 0;
  let countToday = 0;
  for (const r of feeRows) {
    if (new Date(r.created_at) >= todayStart) {
      today += r.amount_tzs;
      countToday += 1;
    }
  }
  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    d.setUTCHours(12, 0, 0, 0);
    const dayStart = new Date(d);
    dayStart.setUTCHours(0, 0, 0, 0);
    const next = new Date(dayStart);
    next.setUTCDate(next.getUTCDate() + 1);
    let total = 0;
    let c = 0;
    for (const r of feeRows) {
      const t = new Date(r.created_at);
      if (t >= dayStart && t < next) {
        total += r.amount_tzs;
        c += 1;
      }
    }
    weekly.push({
      date: dayStart.toISOString().slice(0, 10),
      label: dayStart.toLocaleDateString("en-GB", { weekday: "short" }),
      total_tzs: total,
      deliveries: c,
    });
  }
  const all = driverLedger.filter((l) => l.driver_id === driverId);
  const signedBalance = all.reduce((s, l) => s + (l.amount_tzs || 0), 0);
  const lifetimeFees = feeRows.reduce((s, r) => s + r.amount_tzs, 0);
  return {
    today_earnings_tzs: today,
    deliveries_completed_today: countToday,
    weekly,
    available_balance_tzs: money(signedBalance),
    total_lifetime_fees_tzs: lifetimeFees,
  };
}

export function getDriverHistory(driverId) {
  return driverLedger
    .filter((l) => l.driver_id === driverId && l.type === "delivery_fee")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((l) => ({
      id: l.id,
      created_at: l.created_at,
      amount_tzs: l.amount_tzs,
      order_id: l.meta?.order_id,
    }));
}

export function getDriverPerformance(driverId) {
  const d = drivers.get(driverId);
  if (!d) return null;
  return {
    driver_id: d.id,
    name: d.name,
    rating_avg: d.rating_avg,
    stars_breakdown: { ...d.stars },
    acceptance_rate: Math.round(driverAcceptanceRate(d) * 1000) / 1000,
    on_time_delivery_pct: Math.round(driverOnTimePct(d) * 1000) / 1000,
    deliveries_completed: d.deliveries_completed,
    rating_count: d.rating_count ?? 0,
    priority_score_hint:
      "Higher-rated drivers with strong acceptance and on-time stats rank closer for offers (see driverPriorityScore in drivers.js).",
  };
}

export function requestDriverPayout(driverId, body) {
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  const amount = money(Number(body.amount_tzs));
  if (amount <= 0) throw new Error("Invalid amount");
  const e = getDriverEarnings(driverId);
  if (e.available_balance_tzs < amount) throw new Error("Insufficient balance");
  driverLedger.push({
    id: `dpo_${crypto.randomBytes(5).toString("hex")}`,
    driver_id: driverId,
    type: "payout",
    amount_tzs: -amount,
    created_at: iso(),
    meta: { method: String(body.method || "mpesa"), destination: String(body.destination || "") },
  });
  return { ok: true, amount_tzs: amount };
}

export function findJobByOrderId(orderId) {
  for (const job of jobs.values()) {
    if (job.order_id === orderId) return job;
  }
  return null;
}

export function isOrderAssignedToDriver(orderId, driverId) {
  const job = findJobByOrderId(orderId);
  if (!job) return false;
  return job.driver_id === driverId;
}

export function listJobsForAdmin() {
  return [...jobs.values()].map((j) => ({
    id: j.id,
    order_id: j.order_id,
    status: j.status,
    driver_id: j.driver_id,
    pickup: j.pickup,
    dropoff: j.dropoff,
    earnings_tzs: j.earnings_tzs,
    created_at: j.created_at,
  }));
}

export function adminReassignJob(orderId, newDriverId) {
  const job = findJobByOrderId(orderId);
  if (!job) throw new Error("No delivery job for this order");
  const nd = drivers.get(newDriverId);
  if (!nd) throw new Error("Driver not found");
  if (nd.suspended) throw new Error("Target driver suspended");
  const order = getOrder(orderId);
  if (!order) throw new Error("Order not found");
  const ok = new Set(["ready_for_pickup", "driver_en_route_pickup", "driver_en_route_delivery"]);
  if (!ok.has(order.status)) throw new Error("Cannot reassign in this order state");
  clearJobTimer(job);
  job.offered_driver_id = null;
  job.offer_expires_at = null;
  job.driver_id = newDriverId;
  job.pointer = 0;
  if (order.status === "ready_for_pickup") {
    job.status = "active_pickup";
    transitionOrder(order, "driver_en_route_pickup");
  } else if (order.status === "driver_en_route_pickup") {
    job.status = "active_pickup";
  } else if (order.status === "driver_en_route_delivery") {
    job.status = "active_delivery";
  }
  return job;
}

export function adminSetDriverSuspended(driverId, suspended) {
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  d.suspended = Boolean(suspended);
  if (d.suspended) d.online = false;
  return d;
}

export function adminFlagDriver(driverId, flagged) {
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  d.flagged_for_review = Boolean(flagged);
  return d;
}

export function addCustomerRating(driverId, stars) {
  const d = drivers.get(driverId);
  if (!d) throw new Error("Driver not found");
  const s = Math.min(5, Math.max(1, Math.floor(Number(stars)) || 5));
  d.stars[s] = (d.stars[s] || 0) + 1;
  d.rating_count = (d.rating_count || 0) + 1;
  let sum = 0;
  let n = 0;
  for (let k = 1; k <= 5; k++) {
    sum += k * d.stars[k];
    n += d.stars[k];
  }
  d.rating_avg = Math.round((sum / Math.max(1, n)) * 100) / 100;
  return d;
}
