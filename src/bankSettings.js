/**
 * Bank transfer checkout settings — in-memory with env defaults.
 * Admin configures via /api/admin/settings/bank.
 */

function iso(d = new Date()) {
  return d.toISOString();
}

function envBool(name, defaultWhenUnset) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultWhenUnset;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

const state = {
  enabled: envBool("BANK_CHECKOUT_ENABLED", false),
  bank_name: String(process.env.BANK_NAME || "").trim(),
  account_name: String(process.env.BANK_ACCOUNT_NAME || "").trim(),
  account_number: String(process.env.BANK_ACCOUNT_NUMBER || "").trim(),
  branch: String(process.env.BANK_BRANCH || "").trim(),
  instructions: String(process.env.BANK_INSTRUCTIONS || "").trim(),
  updated_at: null,
  updated_by: null,
};

export function isBankCheckoutEnabled() {
  return Boolean(state.enabled && state.bank_name && state.account_name && state.account_number);
}

export function getBankSettings() {
  return {
    enabled: state.enabled,
    checkout_available: isBankCheckoutEnabled(),
    bank_name: state.bank_name,
    account_name: state.account_name,
    account_number: state.account_number,
    branch: state.branch,
    instructions: state.instructions,
    updated_at: state.updated_at,
  };
}

/** Public details shown to customers at checkout (no admin-only fields). */
export function getPublicBankCheckout() {
  if (!isBankCheckoutEnabled()) {
    return { enabled: false };
  }
  return {
    enabled: true,
    bank_name: state.bank_name,
    account_name: state.account_name,
    account_number: state.account_number,
    branch: state.branch || null,
    instructions: state.instructions || null,
  };
}

export function updateBankSettings(patch, { actorId } = {}) {
  if (!patch || typeof patch !== "object") throw new Error("Invalid settings payload");

  if (patch.enabled != null) state.enabled = Boolean(patch.enabled);
  if (patch.bank_name != null) state.bank_name = String(patch.bank_name).trim().slice(0, 120);
  if (patch.account_name != null) state.account_name = String(patch.account_name).trim().slice(0, 120);
  if (patch.account_number != null) {
    state.account_number = String(patch.account_number).replace(/\s+/g, "").trim().slice(0, 40);
  }
  if (patch.branch != null) state.branch = String(patch.branch).trim().slice(0, 120);
  if (patch.instructions != null) state.instructions = String(patch.instructions).trim().slice(0, 500);

  if (state.enabled) {
    if (!state.bank_name) throw new Error("Bank name is required when bank checkout is enabled");
    if (!state.account_name) throw new Error("Account name is required when bank checkout is enabled");
    if (!state.account_number) throw new Error("Account number is required when bank checkout is enabled");
  }

  state.updated_at = iso();
  state.updated_by = actorId || null;
  return getBankSettings();
}
