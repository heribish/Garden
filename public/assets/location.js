/**
 * Customer city / area detection for shop UI (address text, city pick, GPS).
 */
(function () {
  // Launch hub: Dar es Salaam (synced from /api/public-config delivery_cities when available).
  const CITIES = [{ id: "dar", label: "Dar es Salaam (Kariakoo)", lat: -6.8219, lng: 39.275 }];

  const DAR_AREAS = [
    "Kinondoni",
    "Masaki",
    "Msasani",
    "Oyster Bay",
    "Ubungo",
    "Temeke",
    "Ilala",
    "Kariakoo",
    "Mikocheni",
    "Sinza",
    "Mbezi",
    "Tegeta",
    "Central",
  ];

  function inferCityFromCoords(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // Greater Dar es Salaam metro box (Kinondoni / Ilala / Temeke / Ubungo / Kigamboni).
    if (lat > -7.2 && lat < -6.35 && lng > 38.85 && lng < 39.65) return "dar";
    return null;
  }

  function inferDarArea(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lng > 39.28) return "Msasani";
    if (lat < -6.83) return "Temeke";
    if (lng < 39.18) return "Ubungo";
    return "Central";
  }

  function inferAreaFromAddress(text, cityId) {
    const lower = String(text || "").toLowerCase();
    const areas = cityId === "dar" || /dar\s*es\s*salaam|\bdar\b/.test(lower) ? DAR_AREAS : [];
    for (const a of areas) {
      if (lower.includes(a.toLowerCase())) return a;
    }
    return null;
  }

  function inferCityFromAddress(text) {
    const lower = String(text || "").toLowerCase();
    if (/zanzibar|stone\s*town|unguja/.test(lower)) return "zanzibar";
    if (/dar\s*es\s*salaam|\bdar\b|kinondoni|masaki|msasani|ubungo|temeke|ilala|kariakoo|mikocheni/.test(lower)) return "dar";
    // Match any city in the list by its primary name (text before any parenthesis).
    for (const c of CITIES) {
      if (c.id === "dar" || c.id === "zanzibar") continue;
      const name = c.label.split("(")[0].trim().toLowerCase();
      if (name && lower.includes(name)) return c.id;
    }
    return null;
  }

  function cityById(id) {
    return CITIES.find((c) => c.id === id) || CITIES[0];
  }

  function resolveLocation({ cityId, address, lat, lng, source }) {
    let city = cityById(cityId || "dar");
    let area = null;
    let resolvedSource = source || "city";

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const fromGps = inferCityFromCoords(lat, lng);
      if (fromGps) city = cityById(fromGps);
      const fromAddr = inferCityFromAddress(address || "");
      if (fromAddr) city = cityById(fromAddr);
      else if (city.id === "dar") area = inferDarArea(lat, lng);
      if (source === "gps") resolvedSource = "gps";
    }

    const addrCity = inferCityFromAddress(address || "");
    if (addrCity) {
      city = cityById(addrCity);
      resolvedSource = source === "gps" ? "gps" : "address";
    }

    area = area || inferAreaFromAddress(address, city.id);
    if (area && resolvedSource === "city") resolvedSource = "address";

    return {
      cityId: city.id,
      city: city.label,
      area,
      lat: Number.isFinite(lat) ? lat : city.lat,
      lng: Number.isFinite(lng) ? lng : city.lng,
      source: resolvedSource,
      live: resolvedSource === "gps",
    };
  }

  window.TZLocation = {
    CITIES,
    DAR_AREAS,
    cityById,
    inferCityFromAddress,
    inferCityFromCoords,
    inferAreaFromAddress,
    inferDarArea,
    resolveLocation,
    setCities(list) {
      if (!Array.isArray(list) || !list.length) return CITIES;
      CITIES.length = 0;
      for (const c of list) {
        if (!c || !c.id || !c.label) continue;
        CITIES.push({
          id: String(c.id),
          label: String(c.label),
          lat: Number(c.lat),
          lng: Number(c.lng),
        });
      }
      if (!CITIES.length) {
        CITIES.push({ id: "dar", label: "Dar es Salaam", lat: -6.7924, lng: 39.2083 });
      }
      return CITIES;
    },
  };
})();