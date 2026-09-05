/**
 * Delivery cities shown on the customer checkout city selector.
 * Admin can add / remove entries; defaults match the shop location catalog.
 */

function iso(d = new Date()) {
  return d.toISOString();
}

function slugify(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
}

const DEFAULT_CITIES = [
  { id: "dar", label: "Dar es Salaam", lat: -6.7924, lng: 39.2083 },
  { id: "dodoma", label: "Dodoma", lat: -6.163, lng: 35.7516 },
  { id: "arusha", label: "Arusha", lat: -3.3869, lng: 36.683 },
  { id: "mwanza", label: "Mwanza", lat: -2.5164, lng: 32.9175 },
  { id: "mbeya", label: "Mbeya", lat: -8.9094, lng: 33.4608 },
  { id: "morogoro", label: "Morogoro", lat: -6.8278, lng: 37.6591 },
  { id: "tanga", label: "Tanga", lat: -5.0689, lng: 39.0988 },
  { id: "moshi", label: "Moshi", lat: -3.3349, lng: 37.3404 },
  { id: "tabora", label: "Tabora", lat: -5.0167, lng: 32.8 },
  { id: "kigoma", label: "Kigoma", lat: -4.8769, lng: 29.6267 },
  { id: "zanzibar", label: "Zanzibar City (Stone Town)", lat: -6.1659, lng: 39.2026 },
  { id: "iringa", label: "Iringa", lat: -7.77, lng: 35.69 },
  { id: "musoma", label: "Musoma", lat: -1.5, lng: 33.8 },
  { id: "songea", label: "Songea", lat: -10.6833, lng: 35.65 },
  { id: "shinyanga", label: "Shinyanga", lat: -3.6619, lng: 33.4214 },
  { id: "singida", label: "Singida", lat: -4.8167, lng: 34.75 },
  { id: "bukoba", label: "Bukoba", lat: -1.3333, lng: 31.8167 },
  { id: "mtwara", label: "Mtwara", lat: -10.2667, lng: 40.1833 },
  { id: "lindi", label: "Lindi", lat: -10.0, lng: 39.7167 },
  { id: "sumbawanga", label: "Sumbawanga", lat: -7.9667, lng: 31.6167 },
  { id: "mpanda", label: "Mpanda", lat: -6.3439, lng: 31.0686 },
  { id: "babati", label: "Babati", lat: -4.2167, lng: 35.75 },
  { id: "njombe", label: "Njombe", lat: -9.3333, lng: 34.7667 },
  { id: "bariadi", label: "Bariadi", lat: -2.7967, lng: 33.9886 },
  { id: "geita", label: "Geita", lat: -2.8714, lng: 32.2294 },
  { id: "kibaha", label: "Kibaha", lat: -6.7667, lng: 38.9167 },
  { id: "vwawa", label: "Vwawa (Mbozi)", lat: -9.1, lng: 32.93 },
  { id: "kahama", label: "Kahama", lat: -3.8378, lng: 32.6019 },
  { id: "korogwe", label: "Korogwe", lat: -5.1556, lng: 38.4583 },
  { id: "bagamoyo", label: "Bagamoyo", lat: -6.4333, lng: 38.9 },
  { id: "tunduma", label: "Tunduma", lat: -9.3, lng: 32.7667 },
  { id: "makambako", label: "Makambako", lat: -8.85, lng: 34.8333 },
  { id: "mafinga", label: "Mafinga", lat: -8.2667, lng: 35.2833 },
  { id: "kasulu", label: "Kasulu", lat: -4.5667, lng: 30.1 },
  { id: "nzega", label: "Nzega", lat: -4.2167, lng: 33.1833 },
  { id: "tarime", label: "Tarime", lat: -1.35, lng: 34.3667 },
  { id: "masasi", label: "Masasi", lat: -10.7167, lng: 38.8 },
  { id: "kilwa", label: "Kilwa Masoko", lat: -8.9167, lng: 39.5 },
  { id: "mbinga", label: "Mbinga", lat: -10.9333, lng: 35.0167 },
  { id: "kondoa", label: "Kondoa", lat: -4.9, lng: 35.7833 },
  { id: "handeni", label: "Handeni", lat: -5.4333, lng: 38.0167 },
  { id: "chake", label: "Chake Chake (Pemba)", lat: -5.2459, lng: 39.7666 },
  { id: "wete", label: "Wete (Pemba)", lat: -5.0567, lng: 39.7283 },
  { id: "mkokotoni", label: "Mkokotoni (Zanzibar North)", lat: -5.8728, lng: 39.2553 },
  { id: "koani", label: "Koani (Zanzibar Central)", lat: -6.1333, lng: 39.3167 },
];

/** @type {Map<string, { id: string, label: string, lat: number, lng: number }>} */
const cities = new Map(DEFAULT_CITIES.map((c) => [c.id, { ...c }]));

let updated_at = null;
let updated_by = null;

function publicCity(c) {
  return {
    id: c.id,
    label: c.label,
    lat: c.lat,
    lng: c.lng,
  };
}

export function listDeliveryCities() {
  return [...cities.values()]
    .map(publicCity)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export function getDeliveryCity(id) {
  const c = cities.get(String(id || "").trim());
  return c ? publicCity(c) : null;
}

export function getDeliveryCitiesMeta() {
  return {
    cities: listDeliveryCities(),
    count: cities.size,
    updated_at,
  };
}

/**
 * Add a delivery city. Id is optional (slug from label).
 * Requires label + lat/lng.
 */
export function addDeliveryCity(input = {}, { actorId } = {}) {
  const label = String(input.label || "").trim().slice(0, 80);
  if (label.length < 2) throw new Error("City name is required");
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || lat < -12 || lat > 0) throw new Error("Valid latitude is required (Tanzania range)");
  if (!Number.isFinite(lng) || lng < 29 || lng > 41) throw new Error("Valid longitude is required (Tanzania range)");

  let id = String(input.id || slugify(label)).trim().toLowerCase();
  if (!id) id = `city_${Date.now().toString(36)}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new Error("City id must be letters, numbers, _ or -");
  if (cities.has(id)) throw new Error("A city with this id already exists");

  const row = { id, label, lat, lng };
  cities.set(id, row);
  updated_at = iso();
  updated_by = actorId || null;
  return publicCity(row);
}

/** Remove a delivery city. Dar es Salaam cannot be removed (default hub). */
export function removeDeliveryCity(id, { actorId } = {}) {
  const key = String(id || "").trim();
  if (!key) throw new Error("City id required");
  if (key === "dar") throw new Error("Dar es Salaam is the default hub and cannot be removed");
  if (!cities.has(key)) throw new Error("City not found");
  cities.delete(key);
  updated_at = iso();
  updated_by = actorId || null;
  return { ok: true, id: key };
}

export function resetDeliveryCities({ actorId } = {}) {
  cities.clear();
  for (const c of DEFAULT_CITIES) cities.set(c.id, { ...c });
  updated_at = iso();
  updated_by = actorId || null;
  return getDeliveryCitiesMeta();
}
