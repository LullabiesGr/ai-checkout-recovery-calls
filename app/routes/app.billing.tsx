// app/routes/app.billing.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";

import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Divider,
  Banner,
  TextField,
} from "@shopify/polaris";

import { PLANS, isPlanKey, type PlanKey } from "../lib/billingPlans.shared";
import {
  ensureBillingRow,
  syncBillingFromShopify,
  cancelActiveSubscription,
  requestCapIncrease,
} from "../lib/billing.server";

type LoaderData = {
  shop: string;
  billing: any;
  usage: any | null;
  billingError: string | null;
};

function asErrorMessage(e: unknown) {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Keep ONLY embedded params (shop/host/embedded/locale). Drop id_token/hmac/session/etc.
 */
function embeddedPath(pathname: string, request: Request, extra?: Record<string, string>) {
  const req = new URL(request.url);
  const out = new URL(pathname, req.origin);

  for (const k of ["shop", "host", "embedded", "locale"]) {
    const v = req.searchParams.get(k);
    if (v) out.searchParams.set(k, v);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && String(v).length) out.searchParams.set(k, String(v));
    }
  }

  const qs = out.searchParams.toString();
  return qs ? `${out.pathname}?${qs}` : out.pathname;
}

/**
 * Short returnUrl that lands back inside Admin embedded app.
 */
function billingReturnUrlInAdmin(shop: string) {
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  if (!apiKey) throw new Error("Missing SHOPIFY_API_KEY");
  return `https://${shop}/admin/apps/${apiKey}/app/billing`;
}

function badgeToneFromStatus(status: string) {
  const s = String(status || "").toUpperCase();
  if (s === "ACTIVE") return "success" as const;
  if (s === "PENDING") return "attention" as const;
  if (s === "CANCELLED") return "critical" as const;
  return "info" as const;
}

function formatEUR(amount: number) {
  return new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format(amount);
}

type CouponRule = {
  percentOff?: number; // 0..100
  amountOffEUR?: number; // >= 0
  plans?: string[]; // optional allowlist (e.g. ["STARTER","PRO"])
};

function readCouponsFromEnv(): Record<string, CouponRule> {
  const raw = (process.env.BILLING_COUPONS_JSON ?? "").trim();
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    return obj as Record<string, CouponRule>;
  } catch {
    return {};
  }
}

function normalizeCoupon(code: string) {
  return String(code || "").trim().toUpperCase();
}

function toCents(eur: number) {
  return Math.round(Number(eur) * 100);
}
function fromCents(cents: number) {
  return Math.round(cents) / 100;
}

function applyCouponToMonthlyEUR(args: {
  planKey: PlanKey;
  baseMonthlyEUR: number;
  coupon: string;
}) {
  const coupon = normalizeCoupon(args.coupon);
  if (!coupon) return { monthlyEUR: args.baseMonthlyEUR, applied: null as string | null };

  const coupons = readCouponsFromEnv();
  const rule = coupons[coupon];
  if (!rule) throw new Error("Invalid coupon code");

  if (rule.plans?.length) {
    const ok = rule.plans.map((p) => String(p).toUpperCase()).includes(String(args.planKey).toUpperCase());
    if (!ok) throw new Error("Coupon not applicable to this plan");
  }

  const baseCents = toCents(args.baseMonthlyEUR);
  let newCents = baseCents;

  if (typeof rule.percentOff === "number") {
    const pct = Math.max(0, Math.min(100, rule.percentOff));
    newCents = Math.round(baseCents * (1 - pct / 100));
  }
  if (typeof rule.amountOffEUR === "number") {
    const off = Math.max(0, toCents(rule.amountOffEUR));
    newCents = newCents - off;
  }

  // Keep >= €0.00. (If you want to force minimum €0.01, change here.)
  newCents = Math.max(0, newCents);

  return { monthlyEUR: fromCents(newCents), applied: coupon };
}

function shouldUseTestBilling() {
  const v = (process.env.SHOPIFY_BILLING_TEST ?? "").trim();
  if (!v) return process.env.NODE_ENV !== "production";
  return v !== "0" && v.toLowerCase() !== "false";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const auth: any = await authenticate.admin(request);
  const { admin, session } = auth;
  const shop = session.shop;

  const url = new URL(request.url);
  const billingErrorFromUrl = url.searchParams.get("billing_error");

  await ensureBillingRow(shop);

  let usage: any | null = null;
  let syncErr: string | null = null;

  try {
    const sync = await syncBillingFromShopify({ shop, admin });
    usage = sync?.usage ?? null;
  } catch (e) {
    syncErr = asErrorMessage(e);
  }

  const billing = await db.shopBilling.findUnique({ where: { shop } });

  return {
    shop,
    billing,
    usage,
    billingError: billingErrorFromUrl ?? syncErr,
  } satisfies LoaderData;
}

export async function action({ request }: ActionFunctionArgs) {
  const auth: any = await authenticate.admin(request);
  const { admin, session } = auth;
  const shop = session.shop;

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");
  const couponRaw = String(fd.get("coupon") || "");

  const backToBilling = (extra?: Record<string, string>) =>
    new Response(null, {
      status: 303,
      headers: { Location: embeddedPath("/app/billing", request, extra) },
    });

  const fail = (msg: string) => backToBilling({ billing_error: msg });

  // Always force top-level navigation (no App Bridge postMessage dependency).
  const redirectTop = (url: string) => {
    const html = `<!doctype html><html><head><meta charset="utf-8" />
<meta http-equiv="cache-control" content="no-store" />
<meta http-equiv="pragma" content="no-cache" />
<meta http-equiv="expires" content="0" />
</head><body>
<script>window.top.location.href=${JSON.stringify(url)};</script>
</body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  };

  try {
    if (intent === "select_plan") {
      const planRaw = String(fd.get("plan") || "").toUpperCase();
      if (!isPlanKey(planRaw)) return fail("Invalid plan");

      if (planRaw === "FREE") {
        await cancelActiveSubscription({ shop, admin, prorate: false });
        await db.shopBilling.update({
          where: { shop },
          data: { plan: "FREE", status: "NONE", pendingPlan: null },
        });
        return backToBilling({ ok: "1" });
      }

      const planKey = planRaw as PlanKey;
      const p = PLANS[planKey];
      if (!p) return fail("Invalid plan");

      // Apply coupon to recurring monthly price (only affects subscription fee).
      let recurringMonthlyEUR = Number(p.recurringMonthlyEUR ?? 0);
      let appliedCoupon: string | null = null;

      if (recurringMonthlyEUR > 0 && normalizeCoupon(couponRaw)) {
        const r = applyCouponToMonthlyEUR({
          planKey,
          baseMonthlyEUR: recurringMonthlyEUR,
          coupon: couponRaw,
        });
        recurringMonthlyEUR = r.monthlyEUR;
        appliedCoupon = r.applied;
      } else if (normalizeCoupon(couponRaw) && recurringMonthlyEUR <= 0) {
        // PAYG (0€/month): coupon has no effect on recurring fee.
        // If you want coupons to add bonus minutes instead, handle it elsewhere.
        appliedCoupon = normalizeCoupon(couponRaw);
      }

      const returnUrl = billingReturnUrlInAdmin(shop);
      const test = shouldUseTestBilling();

      const nameParts = [`Ai Checkout Calls - ${planKey}`];
      if (appliedCoupon && recurringMonthlyEUR > 0) nameParts.push(`(${appliedCoupon})`);
      const subscriptionName = nameParts.join(" ");

      const lineItems: any[] = [];

      // Recurring line item (skip if €0/month).
      if (recurringMonthlyEUR > 0) {
        lineItems.push({
          plan: {
            appRecurringPricingDetails: {
              price: { amount: String(recurringMonthlyEUR.toFixed(2)), currencyCode: "EUR" },
            },
          },
        });
      }

      // Usage line item (cap).
      lineItems.push({
        plan: {
          appUsagePricingDetails: {
            cappedAmount: { amount: String(Number(p.usageCapEUR).toFixed(2)), currencyCode: "EUR" },
            terms:
              planKey === "PAYG"
                ? `Usage billed at €${Number(p.overageEURPerMin).toFixed(2)}/min`
                : `Overage billed at €${Number(p.overageEURPerMin).toFixed(2)}/min after included minutes`,
          },
        },
      });

      const mutation = `#graphql
        mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean) {
          appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
            confirmationUrl
            userErrors { field message }
            appSubscription { id status }
          }
        }
      `;

      const resp = await admin.graphql(mutation, {
        variables: {
          name: subscriptionName,
          returnUrl,
          lineItems,
          test,
        },
      });

      const json = await resp.json();
      const create = json?.data?.appSubscriptionCreate;

      const userErrors = create?.userErrors ?? [];
      if (userErrors.length) {
        return fail(String(userErrors[0]?.message || "Billing error"));
      }

      const confirmationUrl = create?.confirmationUrl;
      if (!confirmationUrl) return fail("Missing confirmationUrl");

      await db.shopBilling.update({
        where: { shop },
        data: { pendingPlan: planKey, status: "PENDING" },
      });

      return redirectTop(confirmationUrl);
    }

    if (intent === "increase_cap") {
      const newCapEUR = Number(fd.get("newCapEUR"));
      if (!Number.isFinite(newCapEUR) || newCapEUR <= 0) return fail("Invalid cap amount");

      const { confirmationUrl } = await requestCapIncrease({ shop, admin, newCapEUR });
      return redirectTop(confirmationUrl);
    }

    if (intent === "cancel") {
      await cancelActiveSubscription({ shop, admin, prorate: false });
      return backToBilling({ ok: "1" });
    }

    return fail("Unknown intent");
  } catch (e) {
    return fail(asErrorMessage(e));
  }
}

export default function BillingRoute() {
  const { shop, billing, usage, billingError } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  const [coupon, setCoupon] = React.useState<string>("");

  const isBusy = navigation.state === "submitting" || navigation.state === "loading";
  const activeIntent = navigation.formData?.get("intent")?.toString() ?? "";
  const activePlan = navigation.formData?.get("plan")?.toString() ?? "";

  const activePlanKey = String(billing?.plan || "FREE") as PlanKey;
  const status = String(billing?.status || "NONE");

  const freeRemainingSec = Math.max(0, 10 * 60 - Number(billing?.freeSecondsUsed || 0));
  const freeRemainingMin = Math.floor(freeRemainingSec / 60);

  const plan = PLANS[activePlanKey] ?? PLANS.FREE;
  const includedUsedSec = Number(billing?.includedSecondsUsed || 0);
  const includedTotalSec = plan.includedMinutes * 60;
  const includedRemainingMin = Math.max(0, Math.floor((includedTotalSec - includedUsedSec) / 60));

  const balanceUsed = usage?.balanceUsed ? Number(usage.balanceUsed.amount) : null;
  const capAmount = usage?.cappedAmount ? Number(usage.cappedAmount.amount) : null;

  return (
    <Page title="Billing" subtitle={shop}>
      <Layout>
        <Layout.Section>
          {billingError ? (
            <Banner tone="critical" title="Billing error">
              <p>{billingError}</p>
            </Banner>
          ) : null}

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Current plan
                </Text>
                <Badge tone={badgeToneFromStatus(status)}>{status}</Badge>
              </InlineStack>

              <Text as="p">
                Plan: <b>{activePlanKey}</b>
              </Text>

              {activePlanKey === "FREE" ? (
                <Text as="p">
                  Free minutes remaining: <b>{freeRemainingMin} min</b>
                </Text>
              ) : (
                <>
                  <Text as="p">
                    Included minutes remaining (this cycle): <b>{includedRemainingMin} min</b>
                  </Text>
                  {balanceUsed != null && capAmount != null ? (
                    <Text as="p">
                      Usage spend (this cycle): <b>{formatEUR(balanceUsed)}</b> / cap <b>{formatEUR(capAmount)}</b>
                    </Text>
                  ) : null}
                </>
              )}

              <Divider />

              <InlineStack gap="200">
                {activePlanKey !== "FREE" ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <Button tone="critical" submit loading={isBusy && activeIntent === "cancel"}>
                      Cancel subscription
                    </Button>
                  </Form>
                ) : null}

                {activePlanKey !== "FREE" ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="increase_cap" />
                    <input type="hidden" name="newCapEUR" value={String((capAmount ?? plan.usageCapEUR) + 50)} />
                    <Button submit loading={isBusy && activeIntent === "increase_cap"}>
                      Increase cap +€50
                    </Button>
                  </Form>
                ) : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Plans
              </Text>

              <TextField
                label="Coupon code"
                value={coupon}
                onChange={(v) => setCoupon(v)}
                autoComplete="off"
                helpText="Applies to subscription fee. Enter before selecting a plan."
              />

              {(["FREE", "STARTER", "PRO", "SCALE", "PAYG"] as PlanKey[]).map((k) => {
                const p = PLANS[k];
                const isActive = k === activePlanKey;
                const isThisSubmitting = isBusy && activeIntent === "select_plan" && activePlan === k;

                return (
                  <Card key={k} sectioned>
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="h3" variant="headingSm">
                          {p.title} ({k})
                        </Text>
                        {isActive ? <Badge tone="success">Active</Badge> : null}
                      </InlineStack>

                      {k === "FREE" ? (
                        <Text as="p">€0/month • 10 free phone minutes (one-time)</Text>
                      ) : k === "PAYG" ? (
                        <Text as="p">
                          €0/month • €{Number(p.overageEURPerMin).toFixed(2)}/min • cap {formatEUR(Number(p.usageCapEUR))}
                        </Text>
                      ) : (
                        <Text as="p">
                          {formatEUR(Number(p.recurringMonthlyEUR))}/month • {p.includedMinutes} included min • €
                          {Number(p.overageEURPerMin).toFixed(2)}/min after • cap {formatEUR(Number(p.usageCapEUR))}
                        </Text>
                      )}

                      <Form method="post">
                        <input type="hidden" name="intent" value="select_plan" />
                        <input type="hidden" name="plan" value={k} />
                        <input type="hidden" name="coupon" value={coupon} />
                        <Button submit disabled={isActive} loading={isThisSubmitting}>
                          {isActive ? "Selected" : "Select"}
                        </Button>
                      </Form>
                    </BlockStack>
                  </Card>
                );
              })}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => boundary.headers(args);