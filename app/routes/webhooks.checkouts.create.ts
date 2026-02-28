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
  return x && typeof x === "object" ? Object.keys(x).slice(0, 80) : [];
}

function head(s: string, n = 600) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// Shopify sends checkout webhooks without "id". Use stable token-based key.
function extractCheckoutKey(c: any, root: any): { checkoutId: string; source: string } {
  const pick = (label: string, v: any) => {
    const s = String(v ?? "").trim();
    return s ? ({ checkoutId: s, source: label } as const) : null;
  };

  // Rare cases
  const fromId = pick("id", c?.id ?? root?.id);
  if (fromId) return fromId;

  const fromAdminGid = pick("admin_graphql_api_id", c?.admin_graphql_api_id ?? root?.admin_graphql_api_id);
  if (fromAdminGid) return fromAdminGid;

  // Normal Shopify checkout payload
  const fromToken = pick("token", c?.token ?? root?.token);
  if (fromToken) return fromToken;

  const fromCartToken = pick("cart_token", c?.cart_token ?? root?.cart_token);
  if (fromCartToken) return fromCartToken;

  const fromName = pick("name", c?.name ?? root?.name);
  if (fromName) return fromName;

  return { checkoutId: "", source: "none" };
}

function toFloat(v: any) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function extractValueCurrency(c: any) {
  const value =
    toFloat(c?.total_price) ??
    toFloat(c?.subtotal_price) ??
    toFloat(c?.totalPrice) ??
    null;

  const currency = String(c?.currency || c?.presentment_currency || "USD").toUpperCase();
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
  const ship = c?.shipping_address ?? null;
  const cust = c?.customer ?? null;

  const first = ship?.first_name ?? cust?.first_name ?? "";
  const last = ship?.last_name ?? cust?.last_name ?? "";
  const full = `${String(first).trim()} ${String(last).trim()}`.trim();
  return full ? full : null;
}

function buildItemsJson(c: any): string | null {
  const arr = c?.line_items ?? [];
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const items = arr
    .map((it: any) => ({
      title: it?.title ?? it?.name ?? null,
      quantity: Number(it?.quantity ?? 1),
      variantTitle: it?.variant_title ?? null,
    }))
    .filter((x: any) => x.title);

  return items.length ? JSON.stringify(items) : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const rawText = await request.clone().text().catch(() => "");
  const rawJson = safeJsonParse(rawText);

  console.log("[CHECKOUTS_CREATE] hit", {
    at: new Date().toISOString(),
    rawLen: rawText.length,
    rawParsed: Boolean(rawJson),
    rawKeys: keysOf(rawJson),
    rawHead: head(rawText),
  });

  let topic: any, shop: any, payload: any;
  try {
    const auth = await authenticate.webhook(request);
    topic = (auth as any)?.topic;
    shop = (auth as any)?.shop;
    payload = (auth as any)?.payload;
  } catch (e: any) {
    console.error("[CHECKOUTS_CREATE] authenticate.webhook failed", String(e?.message ?? e));
    return new Response("OK", { status: 200 });
  }

  console.log("[CHECKOUTS_CREATE] authed", {
    topic: String(topic ?? ""),
    shop: String(shop ?? ""),
    payloadType: typeof payload,
    payloadKeys: keysOf(payload),
  });

  if (String(topic ?? "") !== "CHECKOUTS_CREATE") return new Response("Ignored", { status: 200 });

  const root =
    (typeof payload === "string" ? safeJsonParse(payload) : payload) ??
    rawJson ??
    null;

  const c = root;

  console.log("[CHECKOUTS_CREATE] shape", {
    rootType: typeof root,
    rootKeys: keysOf(root),
  });

  const { checkoutId, source } = extractCheckoutKey(c, root);
  if (!checkoutId) {
    console.error("[CHECKOUTS_CREATE] missing checkoutId", { source });
    return new Response("OK", { status: 200 });
  }

  await ensureSettings(shop);

  const token = c?.token ? String(c.token) : null;
  const email = c?.email ? String(c.email) : null;
  const phone = normalizePhoneForStorage(c?.phone);

  const customerName = buildCustomerName(c);
  const itemsJson = buildItemsJson(c);
  const { value: parsedValue, currency: parsedCurrency } = extractValueCurrency(c);

  const existing = await db.checkout.findUnique({
    where: { shop_checkoutId: { shop, checkoutId } },
    select: { status: true, abandonedAt: true, value: true, currency: true },
  });

  const prevStatus = String(existing?.status ?? "");
  const prevAbandonedAt = existing?.abandonedAt ?? null;

  const preserveStatus =
    prevStatus === "ABANDONED" || prevStatus === "RECOVERED" || prevStatus === "CONVERTED";

  const nextStatus = preserveStatus ? prevStatus : "OPEN";
  const nextAbandonedAt = preserveStatus ? prevAbandonedAt : null;

  const value = parsedValue != null ? parsedValue : Number(existing?.value ?? 0);
  const currency = parsedCurrency || String(existing?.currency ?? "USD");

  console.log("[CHECKOUTS_CREATE] upsert start", {
    shop,
    checkoutId,
    idSource: source,
    tokenPresent: Boolean(token),
    nextStatus,
    nextAbandonedAt: nextAbandonedAt ? new Date(nextAbandonedAt).toISOString() : null,
    hasPhone: Boolean(phone),
    value,
    currency,
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
        raw: JSON.stringify(root ?? null),
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
        raw: JSON.stringify(root ?? null),
      },
    });

    console.log("[CHECKOUTS_CREATE] upsert OK", { shop, checkoutId });
  } catch (e: any) {
    console.error("[CHECKOUTS_CREATE] upsert FAILED", {
      shop,
      checkoutId,
      err: String(e?.message ?? e),
    });
  }

  return new Response("OK", { status: 200 });
}