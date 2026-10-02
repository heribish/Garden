/**
 * Platform commission: 10% taken from vendor sales and from driver delivery fares.
 * Customer pays the listed shop price + full delivery fare (no extra markup).
 */
export const VENDOR_PLATFORM_FEE_BPS = 1000;
/** Same rate on driver delivery fare → platform fees. */
export const DRIVER_PLATFORM_FEE_BPS = 1000;

function money(n) {
  if (!Number.isFinite(n)) throw new Error("Invalid amount");
  return Math.round(n);
}

export function platformFeePct() {
  return VENDOR_PLATFORM_FEE_BPS / 100;
}

/** @deprecated use platformFeePct */
export function vendorPlatformFeePct() {
  return platformFeePct();
}

/** 10% of partner gross (vendor sale or driver fare) → platform fees. */
export function platformCommissionFromGross(grossTzs) {
  const gross = Math.max(0, Number(grossTzs) || 0);
  return money((gross * VENDOR_PLATFORM_FEE_BPS) / 10000);
}

export function partnerNetFromGross(grossTzs) {
  const gross = Math.max(0, Number(grossTzs) || 0);
  return money(gross - platformCommissionFromGross(gross));
}

/** Fee preview from a vendor's listed unit price. */
export function platformFeeFromVendorPrice(vendorPriceTzs) {
  return platformCommissionFromGross(vendorPriceTzs);
}

/**
 * Customer pays the vendor's listed price (commission is taken from the vendor later).
 */
export function customerPriceFromVendor(vendorPriceTzs) {
  return money(Math.max(0, Number(vendorPriceTzs) || 0));
}

/** Under commission model, listed price and customer price are the same. */
export function vendorPriceFromCustomer(customerPriceTzs) {
  return money(Math.max(0, Number(customerPriceTzs) || 0));
}

/** @deprecated use platformCommissionFromGross — fee is % of gross, not extracted markup. */
export function platformFeeFromCustomerGross(grossTzs) {
  return platformCommissionFromGross(grossTzs);
}

/** @deprecated use partnerNetFromGross */
export function vendorNetFromCustomerGross(grossTzs) {
  return partnerNetFromGross(grossTzs);
}
