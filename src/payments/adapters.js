/**
 * Mock telco wallet adapters for Tanzania.
 * Replace initiatePayment/verifyWebhook with real PSP/telco HTTP calls.
 */

import crypto from "node:crypto";

export const adapters = {
  mpesa: makeAdapter("mpesa", "M-Pesa (Vodacom)"),
  airtel_money: makeAdapter("airtel_money", "Airtel Money"),
  tigo_pesa: makeAdapter("tigo_pesa", "Tigo Pesa"),
  halopesa: makeAdapter("halopesa", "HaloPesa"),
};

function makeAdapter(provider, label) {
  return {
    provider,
    label,
    /**
     * In production: STK push / USSD orchestration via your PSP.
     * Here: return instructions the demo UI can follow.
     */
    initiatePayment({ payment }) {
      return {
        provider,
        payment_id: payment.id,
        message: `${label}: prompt sent (simulated). Approve on phone or use Dev Tools in the demo page.`,
        next_step: "await_customer_approval",
      };
    },
    /**
     * Mock signature: HMAC-SHA256 hex of `${payment_id}:${amount_tzs}:${status}` with WEBHOOK_SECRET
     */
    buildMockSignature(payment_id, amount_tzs, status, secret) {
      const payload = `${payment_id}:${amount_tzs}:${status}`;
      return crypto.createHmac("sha256", secret).update(payload).digest("hex");
    },
  };
}

export function getAdapter(provider) {
  const a = adapters[provider];
  if (!a) throw new Error(`Unknown provider: ${provider}`);
  return a;
}
