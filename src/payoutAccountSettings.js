/**
 * Platform M-Pesa payout account — the wallet Garden pays vendors & drivers from
 * for end-of-day (and manual) payouts. Separate from customer checkout STK settings.
 */

function iso(d = new Date()) {
  return d.toISOString();
}

function envBool(name, defaultWhenUnset) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultWhenUnset;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

const ACCOUNT_TYPES = new Set(["till", "paybill", "phone"]);

const state = {
  enabled: envBool("PAYOUT_MPESA_ENABLED", false),
  account_name: String(process.env.PAYOUT_MPESA_ACCOUNT_NAME || process.env.BANK_ACCOUNT_NAME || "Garden Tanzania Ltd").trim(),
  account_type: String(process.env.PAYOUT_MPESA_ACCOUNT_TYPE || "till").trim().toLowerCase(),
  /** Till, PayBill, or phone MSISDN used as the source wallet */
  account_number: String(
    process.env.PAYOUT_MPESA_ACCOUNT_NUMBER || process.env.PAYOUT_MPESA_TILL || process.env.MPESA_SHORT_CODE || ""
  ).trim(),
  /** Optional PayBill account reference / store number */
  account_ref: String(process.env.PAYOUT_MPESA_ACCOUNT_REF || "").trim(),
  notes: String(process.env.PAYOUT_MPESA_NOTES || "").trim(),
  updated_at: null,
  updated_by: null,
};

if (!ACCOUNT_TYPES.has(state.account_type)) state.account_type = "till";

export function isPayoutMpesaConfigured() {
  return Boolean(state.enabled && state.account_name && state.account_number);
}

export function getPayoutMpesaSettings() {
  return {
    enabled: state.enabled,
    configured: isPayoutMpesaConfigured(),
    account_name: state.account_name,
    account_type: state.account_type,
    account_number: state.account_number,
    account_ref: state.account_ref,
    notes: state.notes,
    updated_at: state.updated_at,
  };
}

/** Compact summary for Finance / end-of-day screens. */
export function getPayoutMpesaSummary() {
  const s = getPayoutMpesaSettings();
  if (!s.configured) {
    return {
      configured: false,
      label: "Not configured",
      hint: "Add the M-Pesa account Garden pays vendors and drivers from.",
    };
  }
  const typeLabel =
    s.account_type === "paybill" ? "PayBill" : s.account_type === "phone" ? "Phone" : "Till";
  return {
    configured: true,
    label: `${s.account_name} · ${typeLabel} ${s.account_number}`,
    account_name: s.account_name,
    account_type: s.account_type,
    account_number: s.account_number,
    account_ref: s.account_ref || null,
    hint: "Daily vendor and driver payouts are paid from this account.",
  };
}

export function updatePayoutMpesaSettings(patch, { actorId } = {}) {
  if (!patch || typeof patch !== "object") throw new Error("Invalid settings payload");

  if (patch.enabled != null) state.enabled = Boolean(patch.enabled);
  if (patch.account_name != null) state.account_name = String(patch.account_name).trim().slice(0, 120);
  if (patch.account_type != null) {
    const t = String(patch.account_type).trim().toLowerCase();
    if (!ACCOUNT_TYPES.has(t)) throw new Error("account_type must be till, paybill, or phone");
    state.account_type = t;
  }
  if (patch.account_number != null) {
    state.account_number = String(patch.account_number).replace(/\s+/g, "").trim().slice(0, 40);
  }
  if (patch.account_ref != null) state.account_ref = String(patch.account_ref).trim().slice(0, 40);
  if (patch.notes != null) state.notes = String(patch.notes).trim().slice(0, 500);

  if (state.enabled) {
    if (!state.account_name) throw new Error("Account name is required when payout M-Pesa is enabled");
    if (!state.account_number) throw new Error("Till / PayBill / phone number is required when payout M-Pesa is enabled");
  }

  state.updated_at = iso();
  state.updated_by = actorId || null;
  return getPayoutMpesaSettings();
}
