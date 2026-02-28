import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

function toFloat(v: any) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeCheckoutId(raw: any): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith("gid://")) {
    const m = /\/(?:Checkout|AbandonedCheckout)\/(\d+)/.exec(s);
    return m?.[1] ? String(m[1]) : s;
  }
  return s;
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
      sku: it?.sku ?? null,
      variantTitle: it?.variant_title ?? it?.variantTitle ?? null,
      variantId: it?.variant_id ?? it?.variantId ?? null,
      price: it?.price ?? it?.price_set?.shop_money?.amount ?? null,
      currency:
        it?.price_set?.shop_money?.currency_code ??
        it?.price_set?.shop_money?.currencyCode ??
        null,
    }))
    .filter((x: any) => x.title);

  return items.length ? JSON.stringify(items) : null;
}

function extractValueCurrency(c: any) {
  const value =
    toFloat(c?.total_price) ??
    toFloat(c?.totalPrice) ??
    toFloat(c?.total_price_set?.shop_money?.amount) ??
    toFloat(c?.total_price_set?.shopMoney?.amount) ??
    null;

  const currency = String(c?.currency || c?.currency_code || c?.currencyCode || "USD").toUpperCase();
  return { value, currency };
}

export async function action({ request }: ActionFunctionArgs) {
  console.log("[CHECKOUTS_UPDATE] hit", { at: new Date().toISOString() });

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

  const topicStr = String(topic ?? "");
  console.log("[CHECKOUTS_UPDATE] authed", { topic: topicStr, shop: String(shop ?? "") });

  if (!topicStr.toUpperCase().includes("CHECKOUTS_UPDATE")) {
    console.log("[CHECKOUTS_UPDATE] ignored", { topic: topicStr });
    return new Response("Ignored", { status: 200 });
  }

  const c = payload as any;

  const checkoutId = normalizeCheckoutId(c?.id);
  if (!checkoutId) {
    console.log("[CHECKOUTS_UPDATE] missing checkoutId", { rawId: c?.id ?? null });
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
    prevStatus,
    nextStatus,
    prevAbandonedAt: prevAbandonedAt ? new Date(prevAbandonedAt).toISOString() : null,
    nextAbandonedAt: nextAbandonedAt ? new Date(nextAbandonedAt).toISOString() : null,
    hasPhone: Boolean(phone),
    value,
    currency,
    completedAt: Boolean(completedAt),
    rawId: String(c?.id ?? ""),
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
        raw: JSON.stringify(c),
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
        raw: JSON.stringify(c),
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