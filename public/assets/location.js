/**
 * Customer city / area detection for shop UI (address text, city pick, GPS).
 */
(function () {
  // Tanzania regional capitals + major towns (mainland & Zanzibar).
  const CITIES = [
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
  };
})();
