/** Platform commission on vendor-listed prices (added on top for customers). */
export const VENDOR_PLATFORM_FEE_BPS = 1000;

function money(n) {
  if (!Number.isFinite(n)) throw new Error("Invalid amount");
  return Math.round(n);
}

export function vendorPlatformFeePct() {
  return VENDOR_PLATFORM_FEE_BPS / 100;
}

/** App fee on the vendor's base price. */
export function platformFeeFromVendorPrice(vendorPriceTzs) {
  const base = Math.max(0, Number(vendorPriceTzs) || 0);
  return money((base * VENDOR_PLATFORM_FEE_BPS) / 10000);
}

/** Customer-facing price = vendor price + 10% app fee. */
export function customerPriceFromVendor(vendorPriceTzs) {
  const base = Math.max(0, Number(vendorPriceTzs) || 0);
  return money(base + platformFeeFromVendorPrice(base));
}

/** Reverse: vendor base from a customer price that includes the markup. */
export function vendorPriceFromCustomer(customerPriceTzs) {
  const gross = Math.max(0, Number(customerPriceTzs) || 0);
  return money((gross * 10000) / (10000 + VENDOR_PLATFORM_FEE_BPS));
}

/** Platform fee when the order subtotal is the customer total (markup model). */
export function platformFeeFromCustomerGross(grossTzs) {
  const gross = Math.max(0, Number(grossTzs) || 0);
  return money((gross * VENDOR_PLATFORM_FEE_BPS) / (10000 + VENDOR_PLATFORM_FEE_BPS));
}

export function vendorNetFromCustomerGross(grossTzs) {
  const gross = Math.max(0, Number(grossTzs) || 0);
  return money(gross - platformFeeFromCustomerGross(gross));
}
