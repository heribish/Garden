/**
 * Delivery fare from shop → customer, calculated automatically from LATRA
 * (Land Transport Regulatory Authority) digital-hire guide rates for Tanzania.
 *
 * Motorcycle / boda (≤2 pax) — LATRA Jan 2023 notice (still the published hire bands):
 * - short trip ≤ 1 km: TZS 1,000–1,500 → we use 1,500 (upper mid)
 * - starting / base: TZS 250–350 → 300
 * - per kilometre: TZS 300–400 → 350
 * - per minute: TZS 50–70 → 60
 *
 * Formula (auto): max(short-trip floor, base + (km × per_km) + (minutes × per_min))
 * Distance is measured shop → customer; ETA from average urban speed.
 *
 * Source: https://www.latra.go.tz (teksi/pikipiki mtandao nauli).
 * Override rates via env without a code change.
 */

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/** @typedef {'boda' | 'bajaji' | 'car'} FareVehicleClass */

const TABLES = {
  boda: {
    label: "Motorcycle / Boda Boda (LATRA)",
    base_tzs: envInt("FARE_BODA_BASE_TZS", 300),
    per_km_tzs: envInt("FARE_BODA_PER_KM_TZS", 350),
    per_min_tzs: envInt("FARE_BODA_PER_MIN_TZS", 60),
    /** LATRA short-trip band upper for ≤1 km (2-pax motorcycle). */
    min_trip_tzs: envInt("FARE_BODA_MIN_TZS", 1500),
    short_trip_max_km: 1,
    avg_speed_kmh: 22,
  },
  bajaji: {
    label: "Tricycle / Bajaji (LATRA guide)",
    base_tzs: envInt("FARE_BAJAJI_BASE_TZS", 425),
    per_km_tzs: envInt("FARE_BAJAJI_PER_KM_TZS", 550),
    per_min_tzs: envInt("FARE_BAJAJI_PER_MIN_TZS", 80),
    min_trip_tzs: envInt("FARE_BAJAJI_MIN_TZS", 3000),
    short_trip_max_km: 1,
    avg_speed_kmh: 18,
  },
  car: {
    label: "Taxi / Car (LATRA 4-seat guide)",
    base_tzs: envInt("FARE_CAR_BASE_TZS", 750),
    per_km_tzs: envInt("FARE_CAR_PER_KM_TZS", 900),
    per_min_tzs: envInt("FARE_CAR_PER_MIN_TZS", 90),
    min_trip_tzs: envInt("FARE_CAR_MIN_TZS", 4000),
    short_trip_max_km: 1,
    avg_speed_kmh: 25,
  },
};

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function estimateEtaMin(distanceKm, avgKmh = 22) {
  const km = Math.max(0, Number(distanceKm) || 0);
  return Math.max(4, Math.round((km / avgKmh) * 60));
}

function moneyRound100(n) {
  return Math.max(0, Math.round(Number(n) / 100) * 100);
}

/** Public LATRA rate card (default boda) for shop / ops transparency. */
export function getPublicFareRates(vehicle_class = "boda") {
  const cls = TABLES[vehicle_class] ? vehicle_class : "boda";
  const table = TABLES[cls];
  return {
    vehicle_class: cls,
    vehicle_label: table.label,
    authority: "LATRA",
    currency: "TZS",
    base_tzs: table.base_tzs,
    per_km_tzs: table.per_km_tzs,
    per_min_tzs: table.per_min_tzs,
    min_trip_tzs: table.min_trip_tzs,
    short_trip_max_km: table.short_trip_max_km,
    formula: "max(short_trip_floor, base + km×per_km + minutes×per_min)",
    region: "Dar es Salaam",
    basis: "LATRA digital-hire guide for Dar es Salaam (motorcycle/taxi mid-band)",
  };
}

/**
 * Automatically calculate delivery fare from distance using LATRA per-km rules.
 * @param {{ distance_km: number, vehicle_class?: FareVehicleClass }} input
 */
export function calculateDeliveryFare(input = {}) {
  const vehicle_class = TABLES[input.vehicle_class] ? input.vehicle_class : "boda";
  const table = TABLES[vehicle_class];
  const distance_km = Math.round(Math.max(0, Number(input.distance_km) || 0) * 100) / 100;
  const eta_min = estimateEtaMin(distance_km, table.avg_speed_kmh);
  const shortTrip = distance_km <= table.short_trip_max_km;

  const distance_component = table.per_km_tzs * distance_km;
  const time_component = table.per_min_tzs * eta_min;
  const raw = table.base_tzs + distance_component + time_component;

  // LATRA short-trip band for ≤1 km; longer trips use base + per-km + per-minute, not below floor.
  const fare_tzs = shortTrip
    ? table.min_trip_tzs
    : Math.max(table.min_trip_tzs, moneyRound100(raw));

  return {
    vehicle_class,
    vehicle_label: table.label,
    distance_km,
    eta_min,
    fare_tzs,
    currency: "TZS",
    authority: "LATRA",
    per_km_tzs: table.per_km_tzs,
    auto_calculated: true,
    short_trip: shortTrip,
    region: "Dar es Salaam",
    basis: "LATRA digital-hire guide for Dar es Salaam (motorcycle/taxi mid-band)",
    breakdown: {
      base_tzs: table.base_tzs,
      per_km_tzs: table.per_km_tzs,
      per_min_tzs: table.per_min_tzs,
      distance_component_tzs: moneyRound100(distance_component),
      time_component_tzs: moneyRound100(time_component),
      min_trip_tzs: table.min_trip_tzs,
      short_trip_max_km: table.short_trip_max_km,
      raw_tzs: moneyRound100(raw),
      applied: shortTrip ? "latra_short_trip_floor" : "latra_base_plus_km_plus_time",
    },
  };
}

/**
 * Map Garden driver vehicle types onto a LATRA fare class.
 * @param {string | null | undefined} vehicleType
 * @returns {FareVehicleClass}
 */
export function fareClassFromVehicleType(vehicleType) {
  const t = String(vehicleType || "").toLowerCase();
  if (t.includes("bajaji") || t.includes("tuk")) return "bajaji";
  if (t.includes("car") || t.includes("van") || t.includes("taxi")) return "car";
  return "boda";
}
