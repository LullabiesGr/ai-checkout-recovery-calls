// app/routes/app.billing.tsx
import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

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
  error: string | null;
};

function safeErr(v: any, max = 220) {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/** keep embedded params (shop/host/embedded/...) when redirecting back */
function withSearchMerged(path: string, request: Request) {
  const req = new URL(request.url);
  const target = new URL(path, req.origin);
  const out = new URL(target.pathname, req.origin);

  req.searchParams.forEach((v, k) => out.searchParams.set(k, v));
  target.searchParams.forEach((v, k) => out.searchParams.set(k, v));

  const qs = out.searchParams.toString();
  return qs ? `${out.pathname}?${qs}` : out.pathname;
}

function shortReturnUrl(request: Request, shop: string) {
  const u = new URL(request.url);
  const host = u.searchParams.get("host") ?? "";
  const base = `${u.origin}/app/billing?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(
    host
  )}&embedded=1`;

  // Shopify Billing API validates returnUrl length (<=255 chars)
  if (base.length <= 255) return base;

  // absolute fallback (still valid)
  return `${u.origin}/app/billing?shop=${encodeURIComponent(shop)}`;
}

function formatEUR(amount: number) {
  return new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format(amount);
}

function badgeToneFromStatus(status: string) {
  const s = String(status || "").toUpperCase();
  if (s === "ACTIVE") return "success" as const;
  if (s === "PENDING") return "warning" as const;
  if (s === "CANCELLED") return "critical" as const;
  return "info" as const;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureBillingRow(shop);

  // always best-effort sync; never crash the page
  try {
    await syncBillingFromShopify({ shop, admin });
  } catch (e: any) {
    // ignore; show UI anyway from DB
  }

  const billing = await db.shopBilling.findUnique({ where: { shop } });

  const url = new URL(request.url);
  const error = url.searchParams.get("billing_error")
    ? safeErr(url.searchParams.get("billing_error"))
    : null;

  return {
    shop,
    billing,
    usage: null,
    error,
  } satisfies LoaderData;
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session, redirect: shopifyRedirect } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "select_plan") {
      const plan = String(form.get("plan") || "").toUpperCase();
      if (!isPlanKey(plan)) throw new Error("Invalid plan");

      // SHORT returnUrl (no id_token/session/hmac)
      const returnUrl = shortReturnUrl(request, shop);

      if (plan === "FREE") {
        await cancelActiveSubscription({ shop, admin, prorate: false });
        await db.shopBilling.update({
          where: { shop },
          data: { plan: "FREE", status: "NONE", pendingPlan: null },
        });

        return new Response(null, {
          status: 303,
          headers: { Location: withSearchMerged("/app/billing", request) },
        });
      }

      const { confirmationUrl } = await createSubscriptionForPlan({
        shop,
        admin,
        plan: plan as PlanKey,
        returnUrl,
        test: true, // dev stores only
      });

      // TOP-LEVEL redirect (no iframe)
      return shopifyRedirect(confirmationUrl, { target: "_top" });
    }

    if (intent === "increase_cap") {
      const newCapEUR = Number(form.get("newCapEUR"));
      if (!Number.isFinite(newCapEUR) || newCapEUR <= 0) throw new Error("Invalid cap");

      const { confirmationUrl } = await requestCapIncrease({ shop, admin, newCapEUR });
      return shopifyRedirect(confirmationUrl, { target: "_top" });
    }

    if (intent === "cancel") {
      await cancelActiveSubscription({ shop, admin, prorate: false });

      return new Response(null, {
        status: 303,
        headers: { Location: withSearchMerged("/app/billing", request) },
      });
    }

    throw new Error("Unknown intent");
  } catch (e: any) {
    const msg = safeErr(e?.message ?? String(e));
    return new Response(null, {
      status: 303,
      headers: { Location: withSearchMerged(`/app/billing?billing_error=${encodeURIComponent(msg)}`, request) },
    });
  }
}

export default function BillingRoute() {
  const { shop, billing, error } = useLoaderData<typeof loader>();

  const activePlanKey = String(billing?.plan || "FREE") as PlanKey;
  const status = String(billing?.status || "NONE");

  const freeRemainingSec = Math.max(0, 10 * 60 - Number(billing?.freeSecondsUsed || 0));
  const freeRemainingMin = Math.floor(freeRemainingSec / 60);

  const plan = PLANS[activePlanKey] ?? PLANS.FREE;

  const includedUsedSec = Number(billing?.includedSecondsUsed || 0);
  const includedTotalSec = plan.includedMinutes * 60;
  const includedRemainingMin = Math.max(0, Math.floor((includedTotalSec - includedUsedSec) / 60));

  return (
    <Page title="Billing" subtitle={shop}>
      <Layout>
        <Layout.Section>
          {error ? (
            <Banner tone="critical" title="Billing error">
              <p>{error}</p>
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
                <Text as="p">
                  Included minutes remaining (this cycle): <b>{includedRemainingMin} min</b>
                </Text>
              )}

              <Divider />

              <InlineStack gap="200">
                {activePlanKey !== "FREE" ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <Button tone="critical" submit>
                      Cancel subscription
                    </Button>
                  </Form>
                ) : null}

                {activePlanKey !== "FREE" ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="increase_cap" />
                    <input type="hidden" name="newCapEUR" value={String((plan.usageCapEUR ?? 0) + 50)} />
                    <Button submit>Increase cap +€50</Button>
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

                      <Form method="post">
                        <input type="hidden" name="intent" value="select_plan" />
                        <input type="hidden" name="plan" value={k} />
                        <Button submit disabled={isActive}>
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