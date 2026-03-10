import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function toFloat(v: any) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function clean(v: any): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") return new Response("Ignored", { status: 200 });

  const o = payload as any;

  const orderId = clean(o?.id);
  if (!orderId) return new Response("Invalid payload", { status: 200 });

  const checkoutId = clean(o?.checkout_id);
  const checkoutToken = clean(o?.checkout_token);

  const total =
    toFloat(
      o?.total_price ??
        o?.totalPrice ??
        o?.current_total_price ??
        o?.total_price_set?.shop_money?.amount
    ) ?? null;

  const currency = String(o?.currency || o?.currency_code || "USD").toUpperCase();
  const financial = clean(o?.financial_status);

  await db.order.upsert({
    where: { shop_orderId: { shop, orderId } },
    create: {
      shop,
      orderId,
      checkoutId,
      checkoutToken,
      total,
      currency,
      financial,
      raw: JSON.stringify(o),
    },
    update: {
      checkoutId,
      checkoutToken,
      total,
      currency,
      financial,
      raw: JSON.stringify(o),
    },
  });

  // Canonical mapping:
  // 1) order.checkoutId -> Checkout.checkoutId
  // 2) else order.checkoutToken -> Checkout.checkoutId
  const matchedCheckout = await db.checkout.findFirst({
    where: {
      shop,
      OR: [
        ...(checkoutId ? [{ checkoutId }] : []),
        ...(!checkoutId && checkoutToken ? [{ checkoutId: checkoutToken }] : []),
      ],
    },
    select: {
      checkoutId: true,
    },
  });

  if (!matchedCheckout) {
    return new Response("OK", { status: 200 });
  }

  const matchedCheckoutId = String(matchedCheckout.checkoutId);

  const lastJob = await db.callJob.findFirst({
    where: {
      shop,
      checkoutId: matchedCheckoutId,
      provider: "vapi",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (lastJob) {
    await db.callJob.update({
      where: { id: lastJob.id },
      data: {
        attributedAt: new Date(),
        attributedOrderId: orderId,
        attributedAmount: total ?? undefined,
      },
    });
  }

  await db.callJob.updateMany({
    where: {
      shop,
      checkoutId: matchedCheckoutId,
      status: { in: ["QUEUED", "CALLING"] },
    },
    data: {
      status: "CANCELED",
      outcome: "ORDER_PLACED",
    },
  });

  // Display-only checkout sync.
  // Order table remains the only source of truth for recovered state.
  await db.checkout.updateMany({
    where: { shop, checkoutId: matchedCheckoutId },
    data: {
      status: "CONVERTED",
      abandonedAt: null,
    },
  });

  return new Response("OK", { status: 200 });
}