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
} from "@shopify/polaris";

import { PLANS, isPlanKey, type PlanKey } from "../lib/billingPlans.shared";
import {
  ensureBillingRow,
  syncBillingFromShopify,
  createSubscriptionForPlan,
  cancelActiveSubscription,
  requestCapIncrease,
} from "../lib/billing.server";

type LoaderData = {
  shop: string;
  billing: any;
  usage: any | null;
  billingError: string | null;
};

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function asErrorMessage(e: unknown) {
  if (!e) return "Unknown error";
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;

  const anyE: any = e;
  if (anyE?.message && typeof anyE.message === "string") return anyE.message;

  // Shopify GraphQL style
  if (Array.isArray(anyE?.graphQLErrors) && anyE.graphQLErrors.length) {
    try {
      return JSON.stringify(anyE.graphQLErrors);
    } catch {
      return "GraphQL error";
    }
  }
  if (anyE?.response?.errors) {
    try {
      return JSON.stringify(anyE.response.errors);
    } catch {
      return "Response error";
    }
  }

  try {
    const s = JSON.stringify(e);
    return s === "{}" ? "Request failed (empty error object)" : s;
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
 * Admin embedded URL (Shopify will iframe your app).
 * Use for "go back" redirects when action ran in _top.
 */
function billingAdminUrl(shop: string, extra?: Record<string, string>) {
  const apiKey = requiredEnv("SHOPIFY_API_KEY");
  const u = new URL(`https://${shop}/admin/apps/${apiKey}/app/billing`);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && String(v).length) u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

/**
 * Return URL for Billing confirmation (MUST be on your app domain).
 * Keep it short to avoid the 255-char limit.
 */
function billingReturnUrlOnApp(request: Request, shop: string) {
  const base =
    (process.env.SHOPIFY_APP_URL ?? process.env.APP_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
  return `${base}/app/billing/confirm?shop=${encodeURIComponent(shop)}`;
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
  const wantsTop = String(fd.get("top") || "") === "1";

  const backToBilling = (extra?: Record<string, string>) => {
    const location = wantsTop
      ? billingAdminUrl(shop, extra)
      : embeddedPath("/app/billing", request, extra);

    return new Response(null, { status: 303, headers: { Location: location } });
  };

  const fail = (msg: string) => backToBilling({ billing_error: msg });

  // If a non-_top submit ever hits this, still try to bust out safely.
  const redirectTopHtml = (url: string) => {
    const html = `<!doctype html><html><head><meta charset="utf-8" /></head>
<body><script>window.top.location.href=${JSON.stringify(url)};</script></body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
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

      const returnUrl = billingReturnUrlOnApp(request, shop);

      const test =
        process.env.SHOPIFY_BILLING_TEST === "true" ||
        (process.env.NODE_ENV !== "production" && process.env.SHOPIFY_BILLING_TEST !== "false");

      const { confirmationUrl } = await createSubscriptionForPlan({
        shop,
        admin,
        plan: planRaw as PlanKey,
        returnUrl,
        test,
      });

      // This request is submitted with target="_top", so a normal redirect works.
      if (wantsTop) {
        return new Response(null, { status: 303, headers: { Location: confirmationUrl } });
      }

      return redirectTopHtml(confirmationUrl);
    }

    if (intent === "increase_cap") {
      const newCapEUR = Number(fd.get("newCapEUR"));
      if (!Number.isFinite(newCapEUR) || newCapEUR <= 0) return fail("Invalid cap amount");

      const { confirmationUrl } = await requestCapIncrease({ shop, admin, newCapEUR });

      if (wantsTop) {
        return new Response(null, { status: 303, headers: { Location: confirmationUrl } });
      }

      return redirectTopHtml(confirmationUrl);
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
                  <Form method="post" reloadDocument target="_top">
                    <input type="hidden" name="intent" value="increase_cap" />
                    <input type="hidden" name="top" value="1" />
                    <input
                      type="hidden"
                      name="newCapEUR"
                      value={String((capAmount ?? plan.usageCapEUR) + 50)}
                    />
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

              {(["FREE", "STARTER", "PRO", "SCALE", "PAYG"] as PlanKey[]).map((k) => {
                const p = PLANS[k];
                const isActive = k === activePlanKey;
                const isThisSubmitting = isBusy && activeIntent === "select_plan" && activePlan === k;

                const needsConfirmation = k !== "FREE"; // anything non-free must open Shopify confirmation
                const formProps: any = needsConfirmation
                  ? { reloadDocument: true, target: "_top" }
                  : {};

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
                          €0/month • €{p.overageEURPerMin.toFixed(2)}/min • cap {formatEUR(p.usageCapEUR)}
                        </Text>
                      ) : (
                        <Text as="p">
                          {formatEUR(p.recurringMonthlyEUR)}/month • {p.includedMinutes} included min • €
                          {p.overageEURPerMin.toFixed(2)}/min after • cap {formatEUR(p.usageCapEUR)}
                        </Text>
                      )}

                      <Form method="post" {...formProps}>
                        <input type="hidden" name="intent" value="select_plan" />
                        <input type="hidden" name="plan" value={k} />
                        {needsConfirmation ? <input type="hidden" name="top" value="1" /> : null}
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