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
      cache: "no-store",
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

  let deferredInstallPrompt = null;

  function initInstallPrompt(buttonId = "btnInstallApp") {
    const btn = document.getElementById(buttonId);
    if (!btn) return;

    const show = () => {
      btn.hidden = false;
    };
    const hide = () => {
      btn.hidden = true;
    };

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      show();
    });

    btn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (outcome === "accepted") hide();
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      hide();
      showToast(t("nav.installDone") || "App installed", "success");
    });

    if (window.matchMedia("(display-mode: standalone)").matches) hide();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    });
  }

  registerServiceWorker();

  /** Downscale an image file to a compact JPEG data URL (stays under API body limit). */
  function fileToDataUrl(file, maxDim = 480, quality = 0.78) {
    return new Promise((resolve, reject) => {
      if (!file || !String(file.type || "").startsWith("image/")) {
        reject(new Error("Please choose an image file"));
        return;
      }
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => reject(new Error("Could not read image"));
        img.src = fr.result;
      };
      fr.onerror = () => reject(new Error("Could not read image"));
      fr.readAsDataURL(file);
    });
  }

  /** Fill an avatar host with photo or name initial. */
  function renderAvatar(el, { url, name } = {}) {
    if (!el) return;
    const initial = String(name || "G").charAt(0).toUpperCase() || "G";
    if (url) {
      el.classList.add("has-photo");
      el.innerHTML = `<img src="${esc(url)}" alt="" />`;
      el.setAttribute("aria-hidden", "true");
    } else {
      el.classList.remove("has-photo");
      el.textContent = initial;
      el.setAttribute("aria-hidden", "true");
    }
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
    fileToDataUrl,
    renderAvatar,
    canAccessVendor,
    canAccessDriver,
    canAccessAdmin,
    initInstallPrompt,
  };
})();
