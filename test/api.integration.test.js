import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");

function uniquePort() {
  return 3900 + Math.floor(Math.random() * 200);
}

function createClient(baseUrl) {
  let cookie = "";
  return {
    async request(pathname, options = {}) {
      const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie && setCookie.includes("sid=")) {
        cookie = setCookie.split(";")[0];
      }
      return res;
    },
  };
}

async function startServer() {
  const port = uniquePort();
  const child = spawn("node", ["src/server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: "",
      NODE_ENV: "development",
      ENABLE_DEV_TOOLS: "1",
      AUTH_DEV_PERSIST: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start in time")), 15000);
    child.stdout.on("data", (buf) => {
      if (String(buf).includes("garden listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (buf) => {
      const msg = String(buf);
      if (msg.toLowerCase().includes("failed")) {
        clearTimeout(timer);
        reject(new Error(msg));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early: ${code}`));
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

test("public admin signup is blocked without invite", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const anon = createClient(baseUrl);
    const res = await anon.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Actor",
        email: "bad-actor@garden.local",
        password: "Password123!",
        role: "admin",
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.match(String(body.error || ""), /invitation/i);
  } finally {
    child.kill();
  }
});

test("vendor and driver signup intents create shopper accounts with applications", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const anon = createClient(baseUrl);
    let r = await anon.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: "Driver One",
        phone: "255744888002",
        email: "new-driver@garden.local",
        password: "Password123!",
        role: "driver",
        national_id: "19900101123456789012",
        license_number: "DL-123456",
        license_expiry: "2028-12-31",
        vehicle_type: "Boda Boda",
        vehicle_make: "Bajaj",
        vehicle_model: "Boxer",
        vehicle_year: 2020,
        vehicle_plate: "T123ABC",
        vehicle_color: "Red",
        emergency_contact: "255744000000",
      }),
    });
    assert.equal(r.status, 201);
    const driverBody = await r.json();
    assert.equal(driverBody.user.role, "shopper");
    assert.equal(driverBody.user.driver_id, null);
    assert.equal(driverBody.next_step, "driver_pending_approval");
    assert.ok(driverBody.driver_application);
    assert.equal(driverBody.driver_application.status, "pending");
    assert.equal(driverBody.driver_application.user_id, driverBody.user.id);

    r = await anon.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: "Vendor One",
        phone: "255744888001",
        email: "new-vendor@garden.local",
        password: "Password123!",
        role: "vendor",
        business_name: "Test Market",
        zone: "Kinondoni",
      }),
    });
    assert.equal(r.status, 201);
    const vendorBody = await r.json();
    assert.equal(vendorBody.user.role, "shopper");
    assert.equal(vendorBody.next_step, "vendor_pending_approval");
    assert.ok(vendorBody.vendor_application);
    assert.equal(vendorBody.vendor_application.user_id, vendorBody.user.id);
  } finally {
    child.kill();
  }
});

test("account hub exposes orders and driver verification flow", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const client = createClient(baseUrl);
    const admin = createClient(baseUrl);

    let r = await client.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: "Carol Shopper",
        email: "carol@garden.local",
        password: "Password123!",
      }),
    });
    assert.equal(r.status, 201);
    const signup = await r.json();

    r = await client.request("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        vendor_id: "v1",
        customer_name: "Carol",
        customer_phone: "255744000222",
        dropoff_label: "Plot 8, Oysterbay",
        customer_city: "Dar es Salaam",
        payment_method: "mpesa",
        items: [{ product_id: "p1", qty: 2 }],
      }),
    });
    assert.equal(r.status, 201);

    r = await client.request("/api/account");
    assert.equal(r.status, 200);
    const account = await r.json();
    assert.equal(account.account.orders.length, 1);
    assert.equal(account.account.capabilities.shopper, true);

    r = await client.request("/api/account/driver-application", {
      method: "POST",
      body: JSON.stringify({
        national_id: "19900101-12345-67890-12",
        license_number: "DL-998877",
        license_expiry: "2028-12-31",
        vehicle_type: "Motorbike",
        vehicle_make: "Honda",
        vehicle_model: "CB125",
        vehicle_year: 2019,
        vehicle_plate: "T123ABC",
        vehicle_color: "Red",
      }),
    });
    assert.equal(r.status, 201);

    r = await admin.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@garden.local", password: "admin1234" }),
    });
    assert.equal(r.status, 200);

    const list = await admin.request("/api/admin/driver-applications");
    const listBody = await list.json();
    const app = (listBody.applications || []).find((a) => a.user_id === signup.user.id);
    assert.ok(app, "driver application should be listed");

    const approve = await admin.request(`/api/admin/driver-applications/${app.id}/approve`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(approve.status, 200);
    const approved = await approve.json();
    assert.ok(approved.driver?.id);

    r = await client.request("/api/auth/me");
    const me = await r.json();
    assert.equal(me.user.driver_verification_status, "verified");
    assert.ok(me.user.driver_id);
    assert.equal(me.user.capabilities.driver.status, "verified");
  } finally {
    child.kill();
  }
});

test("orders and payments are ownership scoped", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const shopperA = createClient(baseUrl);
    const shopperB = createClient(baseUrl);

    let r = await shopperA.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Alice", email: "alice@garden.local", password: "Password123!" }),
    });
    assert.equal(r.status, 201);

    r = await shopperB.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Bob", email: "bob@garden.local", password: "Password123!" }),
    });
    assert.equal(r.status, 201);

    const createOrder = await shopperA.request("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        vendor_id: "v1",
        customer_name: "Alice",
        customer_phone: "255744000111",
        dropoff_label: "Plot 12, Masaki, Kinondoni",
        customer_city: "Dar es Salaam",
        payment_method: "mpesa",
        items: [{ product_id: "p1", qty: 1 }],
      }),
    });
    assert.equal(createOrder.status, 201);
    const createBody = await createOrder.json();
    const orderId = createBody.order.id;

    const forbiddenGet = await shopperB.request(`/api/orders/${orderId}`);
    assert.equal(forbiddenGet.status, 403);

    const forbiddenPay = await shopperB.request("/api/payments/initiate", {
      method: "POST",
      body: JSON.stringify({
        order_id: orderId,
        provider: "mpesa",
        msisdn: "0744000000",
      }),
    });
    assert.equal(forbiddenPay.status, 403);
  } finally {
    child.kill();
  }
});

test("vendor applications can be submitted and approved with vendor account provisioning", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const applicant = createClient(baseUrl);
    const admin = createClient(baseUrl);

    let r = await applicant.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: "Hassan",
        email: "hassan.vendor@garden.local",
        password: "vendor-pass-123",
      }),
    });
    assert.equal(r.status, 201);

    r = await applicant.request("/api/vendor-applications", {
      method: "POST",
      body: JSON.stringify({
        business_name: "Mwenge Farm Stand",
        contact_name: "Hassan",
        contact_email: "hassan.vendor@garden.local",
        contact_phone: "255744888777",
        zone: "Kinondoni",
      }),
    });
    assert.equal(r.status, 201);
    const created = await r.json();
    assert.equal(created.application.status, "pending");

    r = await admin.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "admin@garden.local",
        password: "admin1234",
      }),
    });
    assert.equal(r.status, 200);

    const list = await admin.request("/api/admin/applications");
    assert.equal(list.status, 200);
    const listBody = await list.json();
    const target = (listBody.applications || []).find((a) => a.id === created.application.id);
    assert.ok(target, "submitted application should be listed");

    const approve = await admin.request(`/api/admin/applications/${target.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        email: "approved.vendor@garden.local",
      }),
    });
    assert.equal(approve.status, 200);
    const approveBody = await approve.json();
    assert.equal(approveBody.application.status, "approved");
    assert.equal(approveBody.vendor_user.role, "vendor");
    assert.equal(approveBody.vendor_user.vendor_id, approveBody.vendor_id);
  } finally {
    child.kill();
  }
});

test("admin end-of-day generates vendor payout requests from exact day sales", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const admin = createClient(baseUrl);
    let r = await admin.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@garden.local", password: "admin1234" }),
    });
    assert.equal(r.status, 200);

    r = await admin.request("/api/admin/finance/end-of-day/generate", {
      method: "POST",
      body: "{}",
    });
    assert.equal(r.status, 200);
    const gen = await r.json();
    assert.ok(gen.day_key);
    assert.ok(Array.isArray(gen.vendors));
    assert.ok(Array.isArray(gen.requests));
    assert.ok(Array.isArray(gen.drivers));
    assert.ok(Array.isArray(gen.driver_requests));

    r = await admin.request(`/api/admin/finance/end-of-day?day=${encodeURIComponent(gen.day_key)}`);
    assert.equal(r.status, 200);
    const snap = await r.json();
    assert.equal(snap.day_key, gen.day_key);
    assert.ok(snap.driver_totals);
    assert.ok(Array.isArray(snap.drivers));

    // Second generate is idempotent — no duplicate pending for same vendor/driver/day
    r = await admin.request("/api/admin/finance/end-of-day/generate", {
      method: "POST",
      body: JSON.stringify({ day: gen.day_key }),
    });
    assert.equal(r.status, 200);
    const again = await r.json();
    assert.equal((again.vendor_created || []).length, 0);
    assert.equal((again.driver_created || []).length, 0);
    assert.equal((again.created || []).length, 0);
  } finally {
    child.kill();
  }
});

test("admin can configure bank checkout settings", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const admin = createClient(baseUrl);
    let r = await admin.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@garden.local", password: "admin1234" }),
    });
    assert.equal(r.status, 200);

    r = await admin.request("/api/admin/settings/bank", {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        bank_name: "CRDB Bank",
        account_name: "Garden Tanzania Ltd",
        account_number: "0150123456789",
        branch: "Kariakoo",
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.settings.checkout_available, true);
    assert.equal(body.settings.bank_name, "CRDB Bank");

    const pub = await admin.request("/api/public-config");
    assert.equal(pub.status, 200);
    const cfg = await pub.json();
    assert.equal(cfg.bank_enabled, true);
    assert.equal(cfg.bank.account_number, "0150123456789");
  } finally {
    child.kill();
  }
});

test("admin can add and remove delivery cities for customer checkout", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const admin = createClient(baseUrl);
    let r = await admin.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@garden.local", password: "admin1234" }),
    });
    assert.equal(r.status, 200);

    r = await admin.request("/api/admin/settings/delivery-cities", {
      method: "POST",
      body: JSON.stringify({
        label: "Testville",
        id: "testville",
        lat: -6.5,
        lng: 36.5,
      }),
    });
    assert.equal(r.status, 201);
    const added = await r.json();
    assert.equal(added.city.id, "testville");

    r = await admin.request("/api/delivery/cities");
    assert.equal(r.status, 200);
    const pub = await r.json();
    assert.ok(pub.cities.some((c) => c.id === "testville"));

    r = await admin.request("/api/admin/settings/delivery-cities/testville", { method: "DELETE" });
    assert.equal(r.status, 200);

    r = await admin.request("/api/delivery/cities");
    const after = await r.json();
    assert.ok(!after.cities.some((c) => c.id === "testville"));

    r = await admin.request("/api/admin/settings/delivery-cities/dar", { method: "DELETE" });
    assert.equal(r.status, 400);
  } finally {
    child.kill();
  }
});

test("admin can configure M-Pesa payout account for daily vendor/driver pays", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const admin = createClient(baseUrl);
    let r = await admin.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@garden.local", password: "admin1234" }),
    });
    assert.equal(r.status, 200);

    r = await admin.request("/api/admin/settings/payout-mpesa", {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        account_name: "Garden Float",
        account_type: "till",
        account_number: "555111",
        notes: "Daily vendor and driver settlements",
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.settings.configured, true);
    assert.equal(body.settings.account_number, "555111");
    assert.ok(body.summary.configured);
    assert.match(body.summary.label, /Garden Float/);

    r = await admin.request("/api/admin/finance/end-of-day");
    assert.equal(r.status, 200);
    const snap = await r.json();
    assert.equal(snap.payout_mpesa.configured, true);
    assert.equal(snap.payout_mpesa.account_number, "555111");
  } finally {
    child.kill();
  }
});

test("admin can read and update M-Pesa settings", async () => {
  const { child, baseUrl } = await startServer();
  try {
    const anon = createClient(baseUrl);
    const blocked = await anon.request("/api/admin/settings/mpesa");
    assert.equal(blocked.status, 401);

    const admin = createClient(baseUrl);
    let r = await admin.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@garden.local", password: "admin1234" }),
    });
    assert.equal(r.status, 200);

    r = await admin.request("/api/admin/settings/mpesa");
    assert.equal(r.status, 200);
    const initial = await r.json();
    assert.ok(initial.settings);
    assert.ok("callback_url" in initial.settings);

    r = await admin.request("/api/admin/settings/mpesa", {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        short_code: "174379",
        environment: "sandbox",
      }),
    });
    assert.equal(r.status, 200);
    const updated = await r.json();
    assert.equal(updated.settings.short_code, "174379");
    assert.equal(updated.settings.enabled, true);

    r = await admin.request("/api/admin/settings/mpesa/test", { method: "POST", body: "{}" });
    assert.equal(r.status, 200);
    const testBody = await r.json();
    assert.ok(Array.isArray(testBody.validation.issues));
  } finally {
    child.kill();
  }
});
