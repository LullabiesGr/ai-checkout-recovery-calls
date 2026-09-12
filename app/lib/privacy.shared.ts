export type PrivacyPayload = {
  shop_domain?: string;
  customer?: { id?: string | number; email?: string; phone?: string };
  orders_requested?: Array<string | number>;
  orders_to_redact?: Array<string | number>;
  data_request?: { id?: string | number };
};
export function parseObject(value: unknown): Record<string, any> {
  if (typeof value === "string") { try { return parseObject(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function normalizeId(value: unknown) { return String(value ?? "").trim().split("/").pop() || ""; }
export function normalizeEmail(value: unknown) { return String(value ?? "").trim().toLowerCase(); }
export function normalizePhone(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
export function customerMatches(record: unknown, payload: PrivacyPayload): boolean {
  const row = parseObject(record), raw = parseObject(row.raw), customer = parseObject(raw.customer ?? row.customer);
  const wanted = payload.customer;
  if (!wanted) return false;
  const id = normalizeId(wanted.id), email = normalizeEmail(wanted.email), phone = normalizePhone(wanted.phone);
  return Boolean((id && [customer.id, raw.customer_id, row.customerId].some(v => normalizeId(v) === id)) ||
    (email && [row.email, raw.email, raw.contact_email, customer.email].some(v => normalizeEmail(v) === email)) ||
    (phone && [row.phone, raw.phone, customer.phone, raw.shipping_address?.phone, raw.billing_address?.phone].some(v => normalizePhone(v) === phone)));
}
export function privacyIdentityKeys(payload: PrivacyPayload): string[] {
  const c = payload.customer;
  return [c?.id ? `customer:${normalizeId(c.id)}` : "", c?.email ? `email:${normalizeEmail(c.email)}` : "",
    c?.phone ? `phone:${normalizePhone(c.phone)}` : "", ...(payload.orders_to_redact ?? []).map(id => `order:${normalizeId(id)}`)].filter(x => x && !x.endsWith(":"));
}
