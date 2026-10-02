/**
 * Garden main store (fulfillment hub).
 * All merchandise is consolidated at Kariakoo, then delivered to the customer.
 * LATRA fare is always measured from this hub → customer drop-off.
 */

export const MAIN_STORE = {
  id: "kariakoo",
  name: "Garden Market — Kariakoo",
  label: "Garden Market, Kariakoo, Dar es Salaam",
  area: "Kariakoo",
  city: "Dar es Salaam",
  city_id: "dar",
  /** Approximate Kariakoo Market / Uhuru St hub */
  lat: -6.8219,
  lng: 39.275,
};

export function getMainStore() {
  return { ...MAIN_STORE };
}

export function getMainStorePickup() {
  return {
    lat: MAIN_STORE.lat,
    lng: MAIN_STORE.lng,
    label: MAIN_STORE.label,
    area: MAIN_STORE.area,
  };
}
