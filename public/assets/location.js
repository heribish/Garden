/**
 * Customer city / area detection for shop UI (address text, city pick, GPS).
 */
(function () {
  const CITIES = [
    { id: "dar", label: "Dar es Salaam", lat: -6.7924, lng: 39.2083 },
    { id: "arusha", label: "Arusha", lat: -3.3869, lng: 36.683 },
    { id: "mwanza", label: "Mwanza", lat: -2.5164, lng: 32.9175 },
    { id: "dodoma", label: "Dodoma", lat: -6.163, lng: 35.7516 },
    { id: "mbeya", label: "Mbeya", lat: -8.9094, lng: 33.4608 },
    { id: "zanzibar", label: "Zanzibar", lat: -6.1659, lng: 39.2026 },
  ];

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
    if (lat > -7.2 && lat < -6.35 && lng > 38.85 && lng < 39.65) return "dar";
    if (lat > -3.75 && lat < -3.05 && lng > 36.35 && lng < 37.05) return "arusha";
    if (lat > -2.85 && lat < -2.15 && lng > 32.65 && lng < 33.15) return "mwanza";
    if (lat > -6.45 && lat < -5.85 && lng > 35.45 && lng < 36.05) return "dodoma";
    if (lat > -9.15 && lat < -8.55 && lng > 33.15 && lng < 33.75) return "mbeya";
    if (lat > -6.35 && lat < -5.95 && lng > 39.05 && lng < 39.45) return "zanzibar";
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
    if (/arusha/.test(lower)) return "arusha";
    if (/mwanza/.test(lower)) return "mwanza";
    if (/dodoma/.test(lower)) return "dodoma";
    if (/mbeya/.test(lower)) return "mbeya";
    if (/dar\s*es\s*salaam|\bdar\b|kinondoni|masaki|msasani|ubungo|temeke|ilala|kariakoo|mikocheni/.test(lower)) return "dar";
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
  };
})();
