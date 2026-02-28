import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

function safeJsonParse(s: string) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function keysOf(x: any) {
  return x && typeof x === "object" ? Object.keys(x).slice(0, 40) : [];
}

function normalizeCheckoutId(raw: any): { id: string; source: string } {
  const s = String(raw ?? "").trim();
  if (!s) return { id: "", source: "empty" };

  if (s.startsWith("gid://")) {
    const m = /\/(?:Checkout|AbandonedCheckout)\/(\d+)/.exec(s);
    if (m?.[1]) return { id: m[1], source: "gid_digits" };
    return { id: s, source: "gid_full" };
  }

  return { id: s, source: "plain" };
}

function unwrapPayload(p: any) {
  if (!p) return null;
  if (typeof p === "string") return safeJsonParse(p) ?? null;
  return p;
}

function unwrapCheckoutObject(root: any) {
  if (!root || typeof root !== "object") return null;
  return (
    root.checkout ??
    root.abandoned_checkout ??
    root.abandonedCheckout ??
    root.data?.checkout ??
    root.data ??
    root.payload ??
    root
  );
}

function extractCheckoutId(root: any, c: any): { checkoutId: string; source: string } {
  const candidates: Array<[string, any]> = [
    ["c.id", c?.id],
    ["c.checkout_id", c?.checkout_id],
    ["c.checkoutId", c?.checkoutId],
    ["c.admin_graphql_api_id", c?.admin_graphql_api_id],
    ["c.adminGraphqlApiId", c?.adminGraphqlApiId],

    ["root.id", root?.id],
    ["root.checkout_id", root?.checkout_id],
    ["root.checkoutId", root?.checkoutId],
    ["root.admin_graphql_api_id", root?.admin_graphql_api_id],
  ];

  for (const [src, v] of candidates) {
    const n = normalizeCheckoutId(v);
    if (n.id) return { checkoutId: n.id, source: src + ":" + n.source };
  }
  return { checkoutId: "", source: "none" };
}

function toFloat(v: any) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function extractValueCurrency(c: any) {
  const value =
    toFloat(c?.total_price) ??
    toFloat(c?.totalPrice) ??
    toFloat(c?.total_price_set?.shop_money?.amount) ??
    toFloat(c?.total_price_set?.shopMoney?.amount) ??
    toFloat(c?.totalPriceSet?.shopMoney?.amount) ??
    null;

  const currency = String(c?.currency || c?.currency_code || c?.currencyCode || "USD").toUpperCase();
  return { value, currency };
}

function normalizePhoneForStorage(raw: any): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let s = input.replace(/^tel:/i, "").trim();
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("011")) s = "+" + s.slice(3);

  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;

  return hasPlus ? `+${digits}` : digits;
}

function buildCustomerName(c: any): string | null {
  const ship = c?.shipping_address ?? c?.shippingAddress ?? null;
  const bill = c?.billing_address ?? c?.billingAddress ?? null;
  const cust = c?.customer ?? null;

  const first =
    ship?.first_name ??
    ship?.firstName ??
    bill?.first_name ??
    bill?.firstName ??
    cust?.first_name ??
    cust?.firstName ??
    null;

  const last =
    ship?.last_name ??
    ship?.lastName ??
    bill?.last_name ??
    bill?.lastName ??
    cust?.last_name ??
    cust?.lastName ??
    null;

  const full = `${String(first ?? "").trim()} ${String(last ?? "").trim()}`.trim();
  return full ? full : null;
}

function buildItemsJson(c: any): string | null {
  const arr = c?.line_items ?? c?.lineItems ?? c?.items ?? [];
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const items = arr
    .map((it: any) => ({
      title: it?.title ?? it?.name ?? null,
      quantity: Number(it?.quantity ?? 1),
    }))
    .filter((x: any) => x.title);

  return items.length ? JSON.stringify(items) : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const rawText = await request.clone().text().catch(() => "");
  const rawJson = safeJsonParse(rawText);

  console.log("[CHECKOUTS_UPDATE] hit", {
    at: new Date().toISOString(),
    rawLen: rawText.length,
    rawParsed: Boolean(rawJson),
    rawKeys: keysOf(rawJson),
  });

  let topic: any, shop: any, payload: any;
  try {
    const auth = await authenticate.webhook(request);
    topic = (auth as any)?.topic;
    shop = (auth as any)?.shop;
    payload = (auth as any)?.payload;
  } catch (e: any) {
    console.error("[CHECKOUTS_UPDATE] authenticate.webhook failed", String(e?.message ?? e));
    return new Response("OK", { status: 200 });
  }

  console.log("[CHECKOUTS_UPDATE] authed", {
    topic: String(topic ?? ""),
    shop: String(shop ?? ""),
    payloadType: typeof payload,
    payloadKeys: keysOf(payload),
  });

  if (String(topic ?? "") !== "CHECKOUTS_UPDATE") return new Response("Ignored", { status: 200 });

  const root = unwrapPayload(payload) ?? rawJson ?? null;
  const c = unwrapCheckoutObject(root) ?? null;

  console.log("[CHECKOUTS_UPDATE] shape", {
    rootKeys: keysOf(root),
    checkoutKeys: keysOf(c),
  });

  const { checkoutId, source } = extractCheckoutId(root, c);
  if (!checkoutId) {
    console.error("[CHECKOUTS_UPDATE] missing checkoutId", { idSource: source });
    return new Response("OK", { status: 200 });
  }

  await ensureSettings(shop);

  const token = c?.token ? String(c.token) : null;
  const email = c?.email ? String(c.email) : null;
  const phone = normalizePhoneForStorage(c?.phone);

  const completedAt = c?.completed_at ?? c?.completedAt ?? null;

  const customerName = buildCustomerName(c);
  const itemsJson = buildItemsJson(c);
  const { value: parsedValue, currency: parsedCurrency } = extractValueCurrency(c);

  const existing = await db.checkout.findUnique({
    where: { shop_checkoutId: { shop, checkoutId } },
    select: { status: true, abandonedAt: true, value: true, currency: true },
  });

  const prevStatus = String(existing?.status ?? "");
  const prevAbandonedAt = existing?.abandonedAt ?? null;

  // κρατά ABANDONED αν είναι ήδη ABANDONED (για να μη “εξαφανίζεται” ο candidate)
  const nextStatus = completedAt
    ? "CONVERTED"
    : prevStatus === "RECOVERED"
    ? "RECOVERED"
    : prevStatus === "CONVERTED"
    ? "CONVERTED"
    : prevStatus === "ABANDONED"
    ? "ABANDONED"
    : "OPEN";

  const nextAbandonedAt = completedAt ? null : nextStatus === "ABANDONED" ? prevAbandonedAt : null;

  const value = parsedValue != null ? parsedValue : Number(existing?.value ?? 0);
  const currency = parsedCurrency || String(existing?.currency ?? "USD");

  console.log("[CHECKOUTS_UPDATE] upsert start", {
    shop,
    checkoutId,
    idSource: source,
    prevStatus,
    nextStatus,
    nextAbandonedAt: nextAbandonedAt ? new Date(nextAbandonedAt).toISOString() : null,
    hasPhone: Boolean(phone),
    value,
    currency,
    completedAt: Boolean(completedAt),
  });

  try {
    await db.checkout.upsert({
      where: { shop_checkoutId: { shop, checkoutId } },
      create: {
        shop,
        checkoutId,
        token,
        email,
        phone,
        value,
        currency,
        status: nextStatus as any,
        abandonedAt: nextAbandonedAt,
        customerName,
        itemsJson,
        raw: JSON.stringify(c ?? root ?? null),
      },
      update: {
        token,
        email,
        phone,
        value,
        currency,
        status: nextStatus as any,
        abandonedAt: nextAbandonedAt,
        customerName,
        itemsJson,
        raw: JSON.stringify(c ?? root ?? null),
      },
    });

    console.log("[CHECKOUTS_UPDATE] upsert OK", { shop, checkoutId });
  } catch (e: any) {
    console.error("[CHECKOUTS_UPDATE] upsert FAILED", {
      shop,
      checkoutId,
      err: String(e?.message ?? e),
    });
  }

  return new Response("OK", { status: 200 });
}