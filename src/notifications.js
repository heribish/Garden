/**
 * Approval notifications — logs in dev; optional email/SMS when configured.
 */

function logDelivery(channel, payload) {
  // eslint-disable-next-line no-console
  console.log(`[garden notify:${channel}]`, JSON.stringify(payload));
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) return `255${digits.slice(1)}`;
  if (digits.startsWith("255")) return digits;
  if (digits.length === 9) return `255${digits}`;
  return digits;
}

async function sendEmail({ to, subject, body }) {
  const email = String(to || "")
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, skipped: true, reason: "no_email" };

  const apiKey = String(process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.NOTIFICATION_FROM_EMAIL || "garden <noreply@garden.local>").trim();

  if (!apiKey) {
    logDelivery("email", { to: email, subject, body });
    return { ok: true, mode: "log" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [email], subject, text: body }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Email send failed: ${res.status} ${errText}`.slice(0, 200));
  }
  return { ok: true, mode: "resend" };
}

async function sendSms({ to, body }) {
  const msisdn = normalizePhone(to);
  if (!msisdn) return { ok: false, skipped: true, reason: "no_phone" };

  const apiKey = String(process.env.SMS_PROVIDER_API_KEY || "").trim();
  const sender = String(process.env.SMS_SENDER_ID || "Garden").trim();

  if (!apiKey) {
    logDelivery("sms", { to: msisdn, body });
    return { ok: true, mode: "log" };
  }

  // Generic HTTP SMS hook (configure SMS_WEBHOOK_URL for your Tanzania provider).
  const webhook = String(process.env.SMS_WEBHOOK_URL || "").trim();
  if (webhook) {
    const res = await fetch(webhook, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: msisdn, from: sender, message: body }),
    });
    if (!res.ok) throw new Error(`SMS webhook failed: ${res.status}`);
    return { ok: true, mode: "webhook" };
  }

  logDelivery("sms", { to: msisdn, body });
  return { ok: true, mode: "log" };
}

async function notifyChannels({ email, phone, subject, message }) {
  const results = await Promise.allSettled([
    sendEmail({ to: email, subject, body: message }),
    sendSms({ to: phone, body: message }),
  ]);
  return results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason?.message || r.reason) }));
}

export async function notifyVendorApplicationApproved({ application, vendor_id, contact_email, contact_phone }) {
  const name = application?.business_name || "your shop";
  const message = `Garden: "${name}" is approved! Open your vendor dashboard to start selling. Vendor ID: ${vendor_id}.`;
  return notifyChannels({
    email: contact_email || application?.contact_email,
    phone: contact_phone || application?.contact_phone,
    subject: "Your Garden vendor application is approved",
    message,
  });
}

export async function notifyVendorApplicationRejected({ application, contact_email, contact_phone }) {
  const name = application?.business_name || "your application";
  const message = `Garden: We could not approve "${name}" at this time. Visit your account to contact support or re-apply.`;
  return notifyChannels({
    email: contact_email || application?.contact_email,
    phone: contact_phone || application?.contact_phone,
    subject: "Garden vendor application update",
    message,
  });
}

export async function notifyDriverApplicationApproved({ application, driver_id }) {
  const message = `Garden: You are verified as a driver (ID ${driver_id}). Open the driver app and go Online to receive deliveries.`;
  return notifyChannels({
    email: application?.contact_email,
    phone: application?.phone,
    subject: "Garden driver verification approved",
    message,
  });
}

export async function notifyDriverApplicationRejected({ application, reason }) {
  const message = `Garden: Driver verification was not approved.${reason ? ` Reason: ${reason}` : ""} Update your documents in Account → Deliver with Garden.`;
  return notifyChannels({
    email: application?.contact_email,
    phone: application?.phone,
    subject: "Garden driver verification update",
    message,
  });
}
