// app/routes/webhooks.checkouts.update.ts
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

function toFloat(v: any) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
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
      currency: it?.price_set?.shop_money?.currency_code ?? it?.price_set?.shop_money?.currencyCode ?? null,
    }))
    .filter((x: any) => x.title);

  return items.length ? JSON.stringify(items) : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "CHECKOUTS_UPDATE") return new Response("Ignored", { status: 200 });

  const c = payload as any;

  const checkoutId = c?.id != null ? String(c.id) : "";
  const value = toFloat(c?.total_price ?? c?.totalPrice ?? c?.total_price_set?.shop_money?.amount);
  const currency = String(c?.currency || c?.currency_code || "USD").toUpperCase();

  if (!checkoutId || value == null) return new Response("Invalid payload", { status: 200 });

  const token = c?.token ? String(c.token) : null;
  const email = c?.email ? String(c.email) : null;
  const phone = normalizePhoneForStorage(c?.phone);

  const completedAt = c?.completed_at ?? c?.completedAt ?? null;

  const customerName = buildCustomerName(c);
  const itemsJson = buildItemsJson(c);

  await ensureSettings(shop);

  // IMPORTANT FIX:
  // Any update activity means the customer interacted again.
  // If NOT completed -> set status OPEN and clear abandonedAt, so delay-based abandon can start a new cycle.
  // Preserve RECOVERED/CONVERTED.
  const existing = await db.checkout.findUnique({
    where: { shop_checkoutId: { shop, checkoutId } },
    select: { status: true },
  });

  const existingStatus = existing?.status ? String(existing.status) : null;
  const preserveRecovered = existingStatus === "RECOVERED";
  const preserveConverted = existingStatus === "CONVERTED";

  const nextStatus = completedAt
    ? "CONVERTED"
    : preserveRecovered
    ? "RECOVERED"
    : preserveConverted
    ? "CONVERTED"
    : "OPEN";

  const nextAbandonedAt = completedAt ? null : null;

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

  return new Response("OK", { status: 200 });
}