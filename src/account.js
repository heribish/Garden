import { getUserRecord, getUserRecordAsync, setUserDriverState } from "./auth.js";
import { getAllOrders, getOrder, listVendorApplications } from "./store.js";
import * as drv from "./drivers.js";
import {
  createDriverApplicationRecord,
  getDriverApplicationById,
  getDriverApplicationForUser,
  listDriverApplications,
  newDriverApplicationId,
  saveDriverApplicationRecord,
} from "./driverApplications.js";

function iso(d = new Date()) {
  return d.toISOString();
}

export { listDriverApplications };

export async function createDriverApplication(input) {
  const user_id = String(input.user_id || "").trim();
  if (!user_id) throw new Error("user_id required");

  const existing = await getDriverApplicationForUser(user_id);
  if (existing?.status === "pending") {
    throw new Error("You already have a driver verification request under review");
  }

  const u = getUserRecord(user_id) || (await getUserRecordAsync(user_id)) || input.user_snapshot;
  if (!u) throw new Error("User not found");
  if (u.driver_id && (u.driver_verification_status === "verified" || !u.driver_verification_status)) {
    throw new Error("You are already a verified driver");
  }

  const national_id = String(input.national_id || "").trim();
  const license_number = String(input.license_number || "").trim();
  const license_expiry = String(input.license_expiry || "").trim();
  const vehicle_type = String(input.vehicle_type || "").trim();
  const vehicle_plate = String(input.vehicle_plate || "").trim();
  if (!national_id || national_id.length < 5) throw new Error("National ID is required");
  if (!license_number || license_number.length < 4) throw new Error("Driving licence number is required");
  if (!license_expiry || !/^\d{4}-\d{2}-\d{2}$/.test(license_expiry)) {
    throw new Error("Licence expiry must be YYYY-MM-DD");
  }
  if (!vehicle_type) throw new Error("Vehicle type is required");
  if (!vehicle_plate || vehicle_plate.length < 3) throw new Error("Vehicle plate number is required");

  const app = {
    id: newDriverApplicationId(),
    user_id,
    full_name: String(input.full_name || u.name || "").trim() || u.name,
    phone: String(input.phone || u.phone || "").replace(/\D/g, "") || u.phone,
    contact_email: u.email || null,
    national_id,
    license_number,
    license_expiry,
    vehicle_type,
    vehicle_plate: vehicle_plate.toUpperCase(),
    vehicle_color: String(input.vehicle_color || "").trim() || null,
    emergency_contact: String(input.emergency_contact || "").trim() || null,
    notes: String(input.notes || "").trim().slice(0, 500) || null,
    status: "pending",
    created_at: iso(),
    reviewed_at: null,
    rejection_reason: null,
    driver_id: null,
  };
  await createDriverApplicationRecord(app);
  await setUserDriverState(user_id, { driver_verification_status: "pending", driver_id: null });
  return app;
}

export async function approveDriverApplication(appId) {
  const app = await getDriverApplicationById(appId);
  if (!app) throw new Error("Application not found");
  if (app.status !== "pending") throw new Error("Application already processed");

  const driver = drv.provisionDriverForSignup({
    name: app.full_name,
    phone: app.phone,
    vehicle_type: app.vehicle_type,
  });
  drv.setDriverVehicleMeta(driver.id, {
    plate: app.vehicle_plate,
    color: app.vehicle_color,
    license_number: app.license_number,
    license_expiry: app.license_expiry,
    national_id: app.national_id,
    verified_at: iso(),
  });

  app.status = "approved";
  app.reviewed_at = iso();
  app.driver_id = driver.id;
  await saveDriverApplicationRecord(app);
  setUserDriverState(app.user_id, {
    driver_id: driver.id,
    driver_verification_status: "verified",
  });
  return { application: app, driver };
}

export async function rejectDriverApplication(appId, reason) {
  const app = await getDriverApplicationById(appId);
  if (!app) throw new Error("Application not found");
  if (app.status !== "pending") throw new Error("Application already processed");
  app.status = "rejected";
  app.reviewed_at = iso();
  app.rejection_reason = String(reason || "Did not meet verification requirements").slice(0, 500);
  await saveDriverApplicationRecord(app);
  await setUserDriverState(app.user_id, {
    driver_verification_status: "rejected",
    driver_id: null,
  });
  return app;
}

export function listOrdersForCustomer(userId) {
  return getAllOrders()
    .filter((o) => o.customer_user_id === userId)
    .map((o) => sanitizeOrderForCustomer(o))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function sanitizeOrderForCustomer(order) {
  const o = { ...order };
  delete o.delivery_otp;
  return o;
}

export function getVendorApplicationForUser(userId, phone, email) {
  const apps = listVendorApplications();
  const phoneN = String(phone || "").replace(/\D/g, "");
  const emailN = String(email || "")
    .trim()
    .toLowerCase();
  return (
    apps.find((a) => a.user_id === userId) ||
    apps.find((a) => phoneN && a.contact_phone === phoneN) ||
    apps.find((a) => emailN && a.contact_email === emailN) ||
    null
  );
}

export async function buildAccountProfile(user) {
  if (!user) return null;
  const record = getUserRecord(user.id) || (await getUserRecordAsync(user.id)) || user;
  const orders = listOrdersForCustomer(user.id);
  const vendorApp = getVendorApplicationForUser(user.id, user.phone, user.email);
  const driverApp = await getDriverApplicationForUser(user.id);

  const vendorStatus = user.vendor_id
    ? "active"
    : vendorApp
      ? vendorApp.status === "approved"
        ? "active"
        : vendorApp.status
      : "none";

  const driverStatus =
    record.driver_verification_status ||
    user.driver_verification_status ||
    (user.driver_id ? "verified" : driverApp?.status === "pending" ? "pending" : driverApp?.status === "approved" ? "verified" : "none");

  return {
    user,
    stats: {
      orders_count: orders.length,
      total_spent_tzs: orders.reduce((s, o) => s + (o.total_tzs || 0), 0),
    },
    orders,
    capabilities: {
      shopper: true,
      vendor: {
        status: vendorStatus,
        vendor_id: user.vendor_id || vendorApp?.vendor_id || null,
        application: vendorApp,
      },
      driver: {
        status: driverStatus,
        driver_id: user.driver_id || driverApp?.driver_id || null,
        application: driverApp,
      },
      admin: user.role === "admin",
    },
    quick_links: buildQuickLinks(user, vendorStatus, driverStatus),
  };
}

function buildQuickLinks(user, vendorStatus, driverStatus) {
  const links = [{ href: "/", label: "Shop groceries", kind: "shop" }];
  if (user.role === "admin") links.push({ href: "/admin", label: "Operations admin", kind: "admin" });
  if (vendorStatus === "active" && user.vendor_id) {
    links.push({ href: "/vendor", label: "Vendor dashboard", kind: "vendor" });
  }
  if (driverStatus === "verified" && user.driver_id) {
    links.push({ href: "/driver", label: "Driver app", kind: "driver" });
  }
  return links;
}

export function getOrderForCustomer(userId, orderId) {
  const o = getOrder(orderId);
  if (!o || o.customer_user_id !== userId) return null;
  return sanitizeOrderForCustomer(o);
}
