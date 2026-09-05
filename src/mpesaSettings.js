/**
 * M-Pesa (Daraja) configuration — in-memory with env defaults.
 */

function iso(d = new Date()) {
  return d.toISOString();
}

function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function envBool(name, defaultWhenUnset) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultWhenUnset;
  return raw === "1" || raw.toLowerCase() === "true";
}

const state = {
  enabled: envBool("MPESA_ENABLED", true),
  environment: process.env.MPESA_ENVIRONMENT === "production" ? "production" : "sandbox",
  short_code: String(process.env.MPESA_SHORT_CODE || process.env.MPESA_TILL_NUMBER || "").trim(),
  consumer_key: String(process.env.MPESA_CONSUMER_KEY || "").trim(),
  consumer_secret: String(process.env.MPESA_CONSUMER_SECRET || "").trim(),
  passkey: String(process.env.MPESA_PASSKEY || "").trim(),
  updated_at: null,
  updated_by: null,
};

export function isWalletEnvGateOpen() {
  return process.env.WALLET_PAYMENTS_ENABLED === "1" || process.env.NODE_ENV !== "production";
}

export function isMpesaCheckoutEnabled() {
  return isWalletEnvGateOpen() && state.enabled;
}

function isLiveMode() {
  return state.environment === "production";
}

export function getMpesaSettings({ baseUrl } = {}) {
  const root = String(baseUrl || process.env.PUBLIC_APP_URL || "http://127.0.0.1:3780").replace(/\/$/, "");
  const validation = validateMpesaConfig();
  return {
    enabled: state.enabled,
    checkout_available: isMpesaCheckoutEnabled(),
    wallet_env_gate_open: isWalletEnvGateOpen(),
    environment: state.environment,
    live_mode: isLiveMode(),
    short_code: state.short_code,
    consumer_key_preview: state.consumer_key ? maskSecret(state.consumer_key) : "",
    consumer_secret_configured: Boolean(state.consumer_secret),
    passkey_configured: Boolean(state.passkey),
    callback_url: `${root}/api/webhooks/mpesa`,
    validation,
    updated_at: state.updated_at,
  };
}

export function validateMpesaConfig() {
  if (!isLiveMode()) {
    return {
      ok: true,
      issues: [],
      mode: "sandbox",
      note: "Sandbox uses simulated STK Push — no live Daraja calls.",
    };
  }
  const issues = [];
  if (!state.short_code) issues.push("Business short code is required for live payments.");
  if (!state.consumer_key) issues.push("Consumer key is required.");
  if (!state.consumer_secret) issues.push("Consumer secret is required.");
  if (!state.passkey) issues.push("Passkey is required.");
  return {
    ok: issues.length === 0,
    issues,
    mode: "live",
    note: issues.length ? "Complete the fields below before accepting live M-Pesa." : "Ready for live STK Push.",
  };
}

export function updateMpesaSettings(patch, { actorId } = {}) {
  if (!patch || typeof patch !== "object") throw new Error("Invalid settings payload");

  if (patch.enabled != null) state.enabled = Boolean(patch.enabled);
  if (patch.environment != null) {
    const env = String(patch.environment).trim().toLowerCase();
    if (!["sandbox", "production"].includes(env)) throw new Error("environment must be sandbox or production");
    state.environment = env;
  }
  if (patch.short_code != null) state.short_code = String(patch.short_code).trim();
  if (patch.consumer_key != null && String(patch.consumer_key).trim()) {
    state.consumer_key = String(patch.consumer_key).trim();
  }
  if (patch.consumer_secret != null && String(patch.consumer_secret).trim()) {
    state.consumer_secret = String(patch.consumer_secret).trim();
  }
  if (patch.passkey != null && String(patch.passkey).trim()) {
    state.passkey = String(patch.passkey).trim();
  }

  state.updated_at = iso();
  state.updated_by = actorId || null;
  return getMpesaSettings();
}

export function getMpesaRuntimeConfig() {
  return {
    enabled: isMpesaCheckoutEnabled(),
    environment: state.environment,
    demo_mode: !isLiveMode(),
    short_code: state.short_code,
    account_reference: "Garden",
    consumer_key: state.consumer_key,
    consumer_secret: state.consumer_secret,
    passkey: state.passkey,
    stk_timeout_sec: 120,
  };
}
