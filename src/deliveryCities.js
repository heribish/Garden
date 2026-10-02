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

/** Launch hub: Dar es Salaam only (admin can add more cities later). */
/** Dar hub pinned to Kariakoo main store coordinates. */
const DEFAULT_CITIES = [{ id: "dar", label: "Dar es Salaam (Kariakoo)", lat: -6.8219, lng: 39.275 }];

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
