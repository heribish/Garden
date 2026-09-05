/**
 * Delivery fare from shop → customer, aligned with LATRA motorcycle (boda)
 * digital-hire guide bands published for Tanzania.
 *
 * Mid-band motorcycle (≤2 pax) rates used as Garden's default delivery class:
 * - starting / base: TZS 250–350 → 300
 * - per kilometre: TZS 300–400 → 350
 * - per minute: TZS 50–70 → 60
 * - short-trip floor (under ~1 km): TZS 1,500 (within regulated motorcycle band)
 *
 * Sources: LATRA ride-hailing fare notices (2023 guide; 2026 short-trip updates).
 * Rates are configurable via env for ops without a code change.
 */

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/** @typedef {'boda' | 'bajaji' | 'car'} FareVehicleClass */

const TABLES = {
  boda: {
    label: "Motorcycle / Boda Boda (LATRA guide)",
    base_tzs: envInt("FARE_BODA_BASE_TZS", 300),
    per_km_tzs: envInt("FARE_BODA_PER_KM_TZS", 350),
    per_min_tzs: envInt("FARE_BODA_PER_MIN_TZS", 60),
    min_trip_tzs: envInt("FARE_BODA_MIN_TZS", 1500),
    avg_speed_kmh: 22,
  },
  bajaji: {
    label: "Tricycle / Bajaji (LATRA guide)",
    base_tzs: envInt("FARE_BAJAJI_BASE_TZS", 425),
    per_km_tzs: envInt("FARE_BAJAJI_PER_KM_TZS", 550),
    per_min_tzs: envInt("FARE_BAJAJI_PER_MIN_TZS", 80),
    min_trip_tzs: envInt("FARE_BAJAJI_MIN_TZS", 3000),
    avg_speed_kmh: 18,
  },
  car: {
    label: "Taxi / Car (LATRA 4-seat guide)",
    base_tzs: envInt("FARE_CAR_BASE_TZS", 750),
    per_km_tzs: envInt("FARE_CAR_PER_KM_TZS", 900),
    per_min_tzs: envInt("FARE_CAR_PER_MIN_TZS", 90),
    min_trip_tzs: envInt("FARE_CAR_MIN_TZS", 4000),
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

/**
 * @param {{ distance_km: number, vehicle_class?: FareVehicleClass }} input
 */
export function calculateDeliveryFare(input = {}) {
  const vehicle_class = TABLES[input.vehicle_class] ? input.vehicle_class : "boda";
  const table = TABLES[vehicle_class];
  const distance_km = Math.round(Math.max(0, Number(input.distance_km) || 0) * 100) / 100;
  const eta_min = estimateEtaMin(distance_km, table.avg_speed_kmh);
  const distance_component = table.per_km_tzs * distance_km;
  const time_component = table.per_min_tzs * eta_min;
  const raw = table.base_tzs + distance_component + time_component;
  const fare_tzs = Math.max(table.min_trip_tzs, moneyRound100(raw));

  return {
    vehicle_class,
    vehicle_label: table.label,
    distance_km,
    eta_min,
    fare_tzs,
    currency: "TZS",
    basis: "LATRA motorcycle/taxi hire guide (mid-band)",
    breakdown: {
      base_tzs: table.base_tzs,
      per_km_tzs: table.per_km_tzs,
      per_min_tzs: table.per_min_tzs,
      distance_component_tzs: moneyRound100(distance_component),
      time_component_tzs: moneyRound100(time_component),
      min_trip_tzs: table.min_trip_tzs,
      raw_tzs: moneyRound100(raw),
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
