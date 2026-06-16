/**
 * Shared UI helpers for garden (keep dependency-free for static HTML UIs)
 */
(function () {
  const TOAST_TTL = 4200;

  function showToast(message, type = "info") {
    let root = document.getElementById("tz-toast-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "tz-toast-root";
      root.setAttribute("aria-live", "polite");
      document.body.appendChild(root);
    }
    const el = document.createElement("div");
    el.className = "tz-toast tz-toast--" + type;
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => {
      el.classList.add("tz-toast--out");
      setTimeout(() => el.remove(), 220);
    }, TOAST_TTL);
  }

  function moneyTzs(n) {
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("en-TZ", {
      style: "currency",
      currency: "TZS",
      maximumFractionDigits: 0,
    }).format(n);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function prettyJson(obj) {
    return esc(JSON.stringify(obj, null, 2));
  }

  function t(key, params) {
    return window.TZI18n ? window.TZI18n.t(key, params) : key;
  }

  function getLang() {
    return window.TZI18n ? window.TZI18n.getLang() : "sw";
  }

  function setLang(lang) {
    return window.TZI18n ? window.TZI18n.setLang(lang) : lang;
  }

  function initLang() {
    return window.TZI18n ? window.TZI18n.initLang() : "sw";
  }

  function onLangChange(fn) {
    if (window.TZI18n) window.TZI18n.onLangChange(fn);
  }

  function applyDataI18n(root) {
    if (window.TZI18n) window.TZI18n.applyDataI18n(root);
  }

  function roleLabel(role) {
    return window.TZI18n ? window.TZI18n.roleLabel(role) : role;
  }

  function apiFetch(path, options = {}) {
    return fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
  }

  function canAccessVendor(user) {
    if (!user) return false;
    if (user.role === "admin") return true;
    return Boolean(
      user.vendor_id ||
        user.capabilities?.vendor?.status === "active" ||
        (user.role === "vendor" && user.vendor_id)
    );
  }

  function canAccessDriver(user) {
    if (!user) return false;
    if (user.role === "admin") return true;
    const st = user.driver_verification_status || user.capabilities?.driver?.status;
    return Boolean(user.driver_id && (st === "verified" || user.role === "driver"));
  }

  function canAccessAdmin(user) {
    return Boolean(user && user.role === "admin");
  }

  window.TZShop = {
    showToast,
    moneyTzs,
    esc,
    prettyJson,
    t,
    getLang,
    setLang,
    initLang,
    onLangChange,
    applyDataI18n,
    roleLabel,
    apiFetch,
    canAccessVendor,
    canAccessDriver,
    canAccessAdmin,
  };
})();
