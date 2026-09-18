// Shared extraction for Shopify REST webhooks and GraphQL snapshots.
export function objectData(value: any): any {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}
const text = (value: any) => typeof value === "string" ? value.trim() : "";

function personName(value: any, allowFullName = true): string | null {
  if (!value || typeof value !== "object") return null;

  const first = text(value.first_name) || text(value.firstName);
  const last = text(value.last_name) || text(value.lastName);
  const parts = [first, last].filter(Boolean).join(" ").trim();
  if (parts) return parts;

  if (allowFullName) {
    const full = text(value.name) || text(value.displayName) || text(value.fullName);
    // Shopify sometimes returns a blank default-address name as " ". text() removes that.
    if (full) return full;
  }

  return null;
}

export function checkoutName(value: any): string | null {
  const c = objectData(value);

  // Prefer the name the shopper entered for delivery/shipping over the account profile.
  // Shopify uses different field names between REST checkout webhooks, Admin GraphQL,
  // newer checkout shapes and customer/default-address snapshots.
  const candidates = [
    c.shipping_address,
    c.shippingAddress,
    c.delivery_address,
    c.deliveryAddress,
    c.billing_address,
    c.billingAddress,
    c.customer?.shipping_address,
    c.customer?.shippingAddress,
    c.customer?.delivery_address,
    c.customer?.deliveryAddress,
    c.customer?.default_address,
    c.customer?.defaultAddress,
    c.buyerIdentity?.customer?.defaultAddress,
    c.buyer_identity?.customer?.default_address,
    c.customer,
    c.buyerIdentity?.customer,
    c.buyer_identity?.customer,
  ];

  for (const candidate of candidates) {
    const name = personName(candidate, true);
    if (name) return name;
  }

  // Some checkout variants expose first/last name at the checkout root. Do not use
  // root `name`, because in REST checkout payloads it can be an order-like value (#1234).
  return personName(c, false);
}

export function checkoutPhone(value: any): string | null {
  const c = objectData(value);
  for (const a of [
    c,
    c.shipping_address,
    c.shippingAddress,
    c.delivery_address,
    c.deliveryAddress,
    c.billing_address,
    c.billingAddress,
    c.customer,
    c.customer?.default_address,
    c.customer?.defaultAddress,
    c.buyerIdentity?.customer,
    c.buyer_identity?.customer,
  ]) {
    const phone = text(a?.phone) || text(a?.defaultPhoneNumber?.phoneNumber);
    if (phone) return phone;
  }
  return null;
}
export function checkoutItems(value: any): string | null {
  const c = objectData(value);
  const lines = c.line_items ?? c.lineItems?.edges?.map((x: any) => x.node) ?? [];
  if (!Array.isArray(lines) || !lines.length) return null;
  return JSON.stringify(lines.map((it: any) => ({
    id: it.id, variantId: it.variant_id ?? it.variantId, productId: it.product_id ?? it.productId,
    title: it.title ?? it.name, quantity: Number(it.quantity ?? 1),
    variantTitle: it.variant_title ?? it.variantTitle, sku: it.sku,
    image: text(it.image?.url) || text(it.image?.src) || text(it.image) || text(it.image_url) || text(it.imageUrl) || text(it.variant?.image?.url) || text(it.product?.featuredMedia?.preview?.image?.url) || text(it.variant?.product?.featuredMedia?.preview?.image?.url) || text(it.product?.featured_image?.url) || text(it.product?.featuredImage?.url) || null,
  })).filter((it: any) => it.title));
}

export function shopifyOrderLabel(raw: any, fallback: any): string {
  const order = objectData(raw);
  const name = text(order?.name);
  if (name) return name.startsWith("#") ? name : `#${name}`;
  const number = text(order?.order_number) || text(order?.orderNumber);
  if (number) return number.startsWith("#") ? number : `#${number}`;
  const id = text(fallback);
  const compact = id.split("/").filter(Boolean).pop() || id;
  return compact ? `#${compact}` : "—";
}

/**
 * Prefer the merchant-facing checkout reference Shopify includes in webhook
 * payloads. Admin GraphQL does not expose a separate checkout number, but its
 * AbandonedCheckout GID still gives us a stable numeric reference. Never show
 * the long recovery token unless Shopify supplied no human-readable value.
 */
export function shopifyCheckoutLabel(raw: any, fallback: any): string {
  const checkout = objectData(raw);
  const explicit = [
    checkout?.name,
    checkout?.checkout_number,
    checkout?.checkoutNumber,
    checkout?.number,
  ]
    .map((value) => value == null ? "" : String(value).trim())
    .find(Boolean);

  if (explicit) return explicit.startsWith("#") ? explicit : `#${explicit}`;

  const rawId = text(checkout?.id) || text(checkout?.admin_graphql_api_id) || text(checkout?.adminGraphqlApiId);
  const numericId = rawId.match(/(?:^|\/)(\d+)$/)?.[1];
  if (numericId) return `#${numericId}`;

  const id = text(fallback);
  const fallbackNumeric = id.match(/(?:^|\/)(\d+)$/)?.[1];
  if (fallbackNumeric) return `#${fallbackNumeric}`;
  return id ? `…${id.slice(-10)}` : "—";
}
export function unansweredCall(job: any, summary?: any): boolean {
  const ai = objectData(job?.analysisJson)?.aiAnalysis;
  const reason = String(job?.endedReason ?? "").toLowerCase();
  return /voicemail|answering.machine|no.answer|customer.did.not.answer|busy/.test(reason)
    || summary?.voicemail === true || summary?.answered === false
    || /^(no_answer|voicemail|busy)$/.test(String(summary?.call_outcome ?? "").toLowerCase())
    || ai?.answered === false || /voicemail|no_answer|busy/.test(String(ai?.disposition ?? "").toLowerCase());
}
export function waitingReason(outcome: any): string | null {
  const value = String(outcome ?? "");
  if (/MAX_ATTEMPTS_REACHED/.test(value)) return "Maximum call attempts reached for this checkout.";
  if (/ATTEMPT_LIMIT_REACHED|WAITING_FOR_ATTEMPTS/.test(value)) return "No attempts remaining — buy extra attempts or upgrade your plan.";
  if (/ACTIVE_SUBSCRIPTION_REQUIRED|MONTHLY_PLAN_REQUIRED/.test(value)) return "An active monthly plan is required.";
  if (/AUTOMATION_PAUSED/.test(value)) return "Automation is paused.";
  if (/RETRY_SCHEDULED/.test(value)) return "Waiting for the scheduled retry.";
  if (/configuration|Missing .*VAPI/i.test(value)) return "Call provider configuration is missing.";
  return value || null;
}

export function mergeCheckoutItems(incoming: string | null, previous: string | null): string | undefined {
  if (!incoming) return previous || undefined;
  const next = objectData(incoming), old = objectData(previous);
  if (!Array.isArray(next)) return previous || undefined;
  return JSON.stringify(next.map((item: any) => {
    const match = Array.isArray(old) ? old.find((v: any) =>
      (item.id && v.id === item.id) || (item.variantId && v.variantId === item.variantId) ||
      (item.title === v.title && item.variantTitle === v.variantTitle)) : null;
    return { ...item, image: item.image || match?.image || match?.imageUrl || null };
  }));
}
