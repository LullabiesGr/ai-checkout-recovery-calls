import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncAbandonedCheckoutsFromShopify } from "../callRecovery.server";
import {
  formatWhen,
  pickLatestJobByCheckout,
  pickRecordingUrl,
  safeStr,
  type SupabaseCallSummary,
} from "../lib/callInsights.shared";
import { fetchSupabaseSummaries } from "../lib/callInsights.server";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  Thumbnail,
} from "@shopify/polaris";

type OfferInfo = {
  code: string | null;
  type: string | null;
  percent: number | null;
  smsSentAt: string | null;
  smsMessageId: string | null;
};

type LoaderData = {
  shop: string;
  checkoutId: string;
  checkout: {
    status: string;
    updatedAt: string;
    abandonedAt: string | null;
    customerName: string | null;
    phone: string | null;
    email: string | null;
    value: number;
    currency: string;
    itemsJson: string | null;
    recoveryUrl: string | null;
  };
  recoveredOrder: null | {
    orderId: string;
    total: number | null;
    currency: string | null;
    financial: string | null;
    createdAt: string;
  };
  latestJob: null | {
    id: string;
    status: string;
    createdAt: string;
    scheduledFor: string | null;
    attempts: number;
    providerCallId: string | null;
    recordingUrl: string | null;
  };
  offer: OfferInfo;
  sb: SupabaseCallSummary | null;
  recordingUrl: string | null;
};

type CartItem = {
  title?: string | null;
  name?: string | null;
  quantity?: number | string | null;
  qty?: number | string | null;
  variantTitle?: string | null;
  sku?: string | null;
  image?: string | null;
  imageUrl?: string | null;
  thumbnail?: string | null;
  src?: string | null;
  price?: number | string | null;
  currency?: string | null;
};

function parseJson(v: unknown): any {
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

function parseOffer(v: unknown): OfferInfo {
  const j = parseJson(v);
  const offer = j?.offer && typeof j.offer === "object" ? j.offer : null;
  if (!offer) return { code: null, type: null, percent: null, smsSentAt: null, smsMessageId: null };
  const pct = offer.discountPercent == null ? null : Number(offer.discountPercent);
  return {
    code: safeStr(offer.offerCode).trim() || null,
    type: safeStr(offer.offerType).trim() || null,
    percent: Number.isFinite(pct as number) ? pct : null,
    smsSentAt: safeStr(offer.smsSentAt).trim() || null,
    smsMessageId: safeStr(offer.smsMessageSid).trim() || null,
  };
}

function recoveryUrlFromRaw(raw: unknown) {
  const j = parseJson(raw);
  const value = safeStr(j?.abandonedCheckoutUrl ?? j?.abandoned_checkout_url ?? j?.recoveryUrl ?? j?.recovery_url).trim();
  return value || null;
}

function cartItems(itemsJson: unknown): CartItem[] {
  const j = parseJson(itemsJson) ?? itemsJson;
  if (Array.isArray(j)) return j as CartItem[];
  if (Array.isArray((j as any)?.items)) return (j as any).items;
  if (Array.isArray((j as any)?.lineItems)) return (j as any).lineItems;
  return [];
}

function itemImage(item: CartItem) {
  return safeStr(item.imageUrl ?? item.image ?? item.thumbnail ?? item.src).trim() || null;
}

function money(amount: number | null | undefined, currency: string) {
  const value = Number(amount ?? 0);
  const cur = safeStr(currency).toUpperCase() || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(
      Number.isFinite(value) ? value : 0,
    );
  } catch {
    return `${Number.isFinite(value) ? value.toFixed(2) : "0.00"} ${cur}`;
  }
}

function shortId(value: string) {
  const v = safeStr(value).trim();
  return v.length > 14 ? `…${v.slice(-12)}` : v;
}

function checkoutTone(status: string) {
  const v = safeStr(status).toUpperCase();
  if (v === "RECOVERED" || v === "CONVERTED") return "success" as const;
  if (v === "ABANDONED") return "critical" as const;
  return "info" as const;
}

function outcomeTone(value: unknown) {
  const v = safeStr(value).toLowerCase();
  if (v.includes("recovered") || v.includes("converted")) return "success" as const;
  if (v.includes("follow") || v.includes("voicemail")) return "attention" as const;
  if (v.includes("failed") || v.includes("no_answer") || v.includes("not_interested")) return "critical" as const;
  return "info" as const;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const checkoutId = String(params.checkoutId ?? "").trim();
  if (!checkoutId) throw new Response("Missing checkoutId", { status: 400 });

  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 100 });

  const [checkout, jobs, recoveredOrder] = await Promise.all([
    db.checkout.findFirst({
      where: { shop, checkoutId },
      select: {
        checkoutId: true,
        status: true,
        updatedAt: true,
        abandonedAt: true,
        customerName: true,
        phone: true,
        email: true,
        value: true,
        currency: true,
        itemsJson: true,
        raw: true,
      },
    }),
    db.callJob.findMany({
      where: { shop, checkoutId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        attempts: true,
        createdAt: true,
        providerCallId: true,
        recordingUrl: true,
        analysisJson: true,
      },
    }),
    db.order.findFirst({
      where: { shop, OR: [{ checkoutId }, { checkoutToken: checkoutId }] },
      orderBy: { createdAt: "desc" },
      select: { orderId: true, total: true, currency: true, financial: true, createdAt: true },
    }),
  ]);

  if (!checkout) throw new Response("Checkout not found", { status: 404 });

  const latestJobMap = pickLatestJobByCheckout(jobs);
  const j = latestJobMap.get(String(checkout.checkoutId)) ?? null;
  const callId = j?.providerCallId ? String(j.providerCallId) : "";
  const jobId = j?.id ? String(j.id) : "";
  const sbMap = await fetchSupabaseSummaries({
    shop,
    callIds: callId ? [callId] : [],
    callJobIds: jobId ? [jobId] : [],
    checkoutIds: [checkoutId],
  });

  const sb: SupabaseCallSummary | null =
    (callId ? (sbMap.get(`call:${callId}`) as any) : null) ||
    (jobId ? (sbMap.get(`job:${jobId}`) as any) : null) ||
    (sbMap.get(`co:${checkoutId}`) as any) ||
    null;

  const recordingUrl = (pickRecordingUrl(sb) ?? (j?.recordingUrl ? String(j.recordingUrl) : null)) ?? null;

  return {
    shop,
    checkoutId,
    checkout: {
      status: recoveredOrder ? "RECOVERED" : String(checkout.status),
      updatedAt: new Date(checkout.updatedAt).toISOString(),
      abandonedAt: checkout.abandonedAt ? new Date(checkout.abandonedAt).toISOString() : null,
      customerName: checkout.customerName ?? null,
      phone: checkout.phone ?? null,
      email: checkout.email ?? null,
      value: Number(checkout.value ?? 0),
      currency: String(recoveredOrder?.currency ?? checkout.currency ?? "USD"),
      itemsJson: checkout.itemsJson ?? null,
      recoveryUrl: recoveryUrlFromRaw(checkout.raw),
    },
    recoveredOrder: recoveredOrder
      ? {
          orderId: String(recoveredOrder.orderId),
          total: recoveredOrder.total == null ? null : Number(recoveredOrder.total),
          currency: recoveredOrder.currency ?? null,
          financial: recoveredOrder.financial ?? null,
          createdAt: new Date(recoveredOrder.createdAt).toISOString(),
        }
      : null,
    latestJob: j
      ? {
          id: String(j.id),
          status: String(j.status),
          createdAt: new Date(j.createdAt).toISOString(),
          scheduledFor: j.scheduledFor ? new Date(j.scheduledFor).toISOString() : null,
          attempts: Number(j.attempts ?? 0),
          providerCallId: j.providerCallId ? String(j.providerCallId) : null,
          recordingUrl: j.recordingUrl ? String(j.recordingUrl) : null,
        }
      : null,
    offer: parseOffer((j as any)?.analysisJson),
    sb,
    recordingUrl,
  } satisfies LoaderData;
};

export default function CheckoutDetail() {
  const data = useLoaderData<typeof loader>();
  const sb: any = data.sb as any;
  const items = React.useMemo(() => cartItems(data.checkout.itemsJson), [data.checkout.itemsJson]);
  const [copied, setCopied] = React.useState<string | null>(null);

  const copy = React.useCallback((label: string, value: string | null) => {
    const v = safeStr(value).trim();
    if (!v) return;
    void navigator.clipboard?.writeText(v);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1500);
  }, []);

  const buyPct =
    typeof sb?.buy_probability === "number" && Number.isFinite(sb.buy_probability) ? Math.round(sb.buy_probability) : null;
  const outcome = safeStr(sb?.call_outcome).trim();
  const total = data.recoveredOrder?.total ?? data.checkout.value;
  const currency = data.recoveredOrder?.currency ?? data.checkout.currency;

  return (
    <Page
      title={data.checkout.customerName || "Checkout details"}
      subtitle={`Checkout ${shortId(data.checkoutId)}`}
      backAction={{ content: "Checkouts", url: "/app/checkouts" }}
      titleMetadata={<Badge tone={checkoutTone(data.checkout.status)}>{data.checkout.status}</Badge>}
    >
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, md: "1fr 1fr" }} gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <Text as="h2" variant="headingMd">Customer</Text>
                {outcome ? <Badge tone={outcomeTone(outcome)}>{outcome.replace(/_/g, " ").toUpperCase()}</Badge> : null}
              </InlineStack>
              <BlockStack gap="100">
                <Text as="p" variant="headingSm">{data.checkout.customerName || "Guest customer"}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{data.checkout.phone || "No phone number"}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{data.checkout.email || "No email address"}</Text>
              </BlockStack>
              <Divider />
              <InlineGrid columns={2} gap="300">
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">Checkout value</Text>
                  <Text as="p" variant="headingMd">{money(total, currency || data.checkout.currency)}</Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">AI purchase intent</Text>
                  <Text as="p" variant="headingMd">{buyPct == null ? "—" : `${buyPct}%`}</Text>
                </BlockStack>
              </InlineGrid>
              <Text as="p" variant="bodySm" tone="subdued">Updated {formatWhen(data.checkout.updatedAt)}</Text>
              {data.checkout.abandonedAt ? (
                <Text as="p" variant="bodySm" tone="subdued">Abandoned {formatWhen(data.checkout.abandonedAt)}</Text>
              ) : null}
              <InlineStack gap="200">
                {data.checkout.recoveryUrl ? <Button url={data.checkout.recoveryUrl} external>Open checkout</Button> : null}
                {data.recordingUrl ? <Button url={data.recordingUrl} external>Recording</Button> : null}
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Recovery result</Text>
              {data.recoveredOrder ? (
                <Box background="bg-surface-success" borderRadius="300" padding="300">
                  <BlockStack gap="150">
                    <InlineStack gap="150" blockAlign="center">
                      <Badge tone="success">Recovered order</Badge>
                      {data.recoveredOrder.financial ? <Badge>{safeStr(data.recoveredOrder.financial).toUpperCase()}</Badge> : null}
                    </InlineStack>
                    <Text as="p" variant="headingMd">Order {data.recoveredOrder.orderId}</Text>
                    <Text as="p" variant="bodyMd">{money(data.recoveredOrder.total, data.recoveredOrder.currency || data.checkout.currency)}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">Completed {formatWhen(data.recoveredOrder.createdAt)}</Text>
                    <InlineStack gap="150" blockAlign="center">
                      <Button size="slim" onClick={() => copy("order", data.recoveredOrder?.orderId)}>Copy order ID</Button>
                      {copied === "order" ? <Badge tone="success">Copied</Badge> : null}
                    </InlineStack>
                  </BlockStack>
                </Box>
              ) : (
                <Text as="p" variant="bodyMd" tone="subdued">No completed Shopify order has been matched to this checkout yet.</Text>
              )}

              {data.offer.code || data.offer.smsSentAt ? (
                <Box background="bg-surface-secondary" borderRadius="300" padding="300">
                  <BlockStack gap="150">
                    <Text as="h3" variant="headingSm">Offer & SMS</Text>
                    <InlineStack gap="150" blockAlign="center">
                      {data.offer.code ? <Badge tone="success">Coupon {data.offer.code}</Badge> : null}
                      {data.offer.percent ? <Badge tone="info">{data.offer.percent}% off</Badge> : null}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone={data.offer.smsSentAt ? "success" : "subdued"}>
                      {data.offer.smsSentAt ? `SMS sent ${formatWhen(data.offer.smsSentAt)}` : "SMS not sent"}
                    </Text>
                    {data.offer.code ? (
                      <InlineStack gap="150" blockAlign="center">
                        <Button size="slim" onClick={() => copy("coupon", data.offer.code)}>Copy coupon</Button>
                        {copied === "coupon" ? <Badge tone="success">Copied</Badge> : null}
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                </Box>
              ) : null}
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Cart</Text>
              <Badge>{`${items.length} ${items.length === 1 ? "product" : "products"}`}</Badge>
            </InlineStack>
            {items.length === 0 ? (
              <Text as="p" tone="subdued">Product information is not available for this checkout.</Text>
            ) : (
              <BlockStack gap="250">
                {items.slice(0, 12).map((item, index) => {
                  const title = safeStr(item.title ?? item.name).trim() || "Product";
                  const qty = Number(item.quantity ?? item.qty ?? 1);
                  const image = itemImage(item);
                  return (
                    <React.Fragment key={`${title}-${index}`}>
                      {index > 0 ? <Divider /> : null}
                      <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
                        <InlineStack gap="250" blockAlign="center" wrap={false}>
                          {image ? <Thumbnail source={image} alt={title} size="medium" /> : <Box background="bg-surface-secondary" borderRadius="200" padding="300"><Text as="span" tone="subdued">No image</Text></Box>}
                          <BlockStack gap="050">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">{title}</Text>
                            {item.variantTitle ? <Text as="p" variant="bodySm" tone="subdued">{item.variantTitle}</Text> : null}
                            {item.sku ? <Text as="p" variant="bodySm" tone="subdued">SKU {item.sku}</Text> : null}
                          </BlockStack>
                        </InlineStack>
                        <Badge>{`Qty ${Number.isFinite(qty) ? qty : 1}`}</Badge>
                      </InlineStack>
                    </React.Fragment>
                  );
                })}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: "1fr 1fr" }} gap="400">
          <Card>
            <BlockStack gap="200">
              <InlineStack gap="150" blockAlign="center">
                <Text as="h2" variant="headingMd">AI summary</Text>
                {data.latestJob?.status ? <Badge>{data.latestJob.status}</Badge> : null}
              </InlineStack>
              <Text as="p" variant="bodyMd" tone={safeStr(sb?.summary_clean || sb?.summary) ? undefined : "subdued"}>
                {safeStr(sb?.summary_clean || sb?.summary) || "The AI summary will appear after a completed call."}
              </Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="250">
              <Text as="h2" variant="headingMd">Next step</Text>
              <Text as="p" variant="bodyMd" tone={safeStr(sb?.next_best_action || sb?.best_next_action) ? undefined : "subdued"}>
                {safeStr(sb?.next_best_action || sb?.best_next_action) || "No follow-up is required right now."}
              </Text>
              {safeStr(sb?.follow_up_message) ? (
                <Box background="bg-surface-secondary" borderRadius="300" padding="300">
                  <BlockStack gap="150">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Suggested message</Text>
                      <Button size="slim" variant="plain" onClick={() => copy("message", safeStr(sb?.follow_up_message))}>Copy</Button>
                    </InlineStack>
                    <Text as="p" variant="bodySm">{safeStr(sb?.follow_up_message)}</Text>
                    {copied === "message" ? <Badge tone="success">Copied</Badge> : null}
                  </BlockStack>
                </Box>
              ) : null}
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
