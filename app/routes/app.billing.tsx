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
  ProgressBar,
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

function asErrorMessage(e: unknown) {
  if (!e) return "Unknown error";
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;

  const anyE: any = e;
  if (anyE?.message && typeof anyE.message === "string") return anyE.message;

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

function merchantStatusLabel(status: string, plan: PlanKey) {
  const s = String(status || "").toUpperCase();
  if (plan === "FREE" && s === "NONE") return "Free plan";
  if (s === "ACTIVE") return "Active";
  if (s === "PENDING") return "Pending approval";
  if (s === "CANCELLED") return "Cancelled";
  return plan === "FREE" ? "Free plan" : "Subscription status";
}

function formatEUR(amount: number) {
  return new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format(amount);
}

function planPriceLine(planKey: PlanKey) {
  const p = PLANS[planKey];
  if (planKey === "FREE") return `€0/month • ${p.includedAttempts} attempts included`;
  if (planKey === "PAYG") return `€0/month • €${p.overageEURPerAttempt.toFixed(2)} per attempt`;
  return `${formatEUR(p.recurringMonthlyEUR)}/month • ${p.includedAttempts} attempts included`;
}

function planUsageLine(planKey: PlanKey) {
  const p = PLANS[planKey];
  if (planKey === "FREE") return "SMS included with every attempt";
  if (planKey === "PAYG") return `SMS included • Monthly usage cap ${formatEUR(p.usageCapEUR)}`;
  return `Then €${p.overageEURPerAttempt.toFixed(2)} per attempt • SMS included • Cap ${formatEUR(p.usageCapEUR)}`;
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
  const { admin, session, redirect } = auth;
  const shop = session.shop;

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");
  const couponCode = String(fd.get("coupon") || "").trim();

  const backToBilling = (extra?: Record<string, string>) => {
    return redirect(embeddedPath("/app/billing", request, extra));
  };

  const fail = (msg: string) => backToBilling({ billing_error: msg });

  try {
    if (intent === "select_plan") {
      const planRaw = String(fd.get("plan") || "").toUpperCase();
      if (!isPlanKey(planRaw)) return fail("Invalid plan");

      if (planRaw === "FREE") {
        await cancelActiveSubscription({ shop, admin, prorate: false });
        await db.shopBilling.update({
          where: { shop },
          data: {
            plan: "FREE",
            status: "NONE",
            subscriptionId: null,
            usageLineItemId: null,
            recurringLineItemId: null,
            pendingPlan: null,
            pendingCouponId: null,
            pendingCouponCode: null,
            appliedCouponCode: null,
            includedSecondsUsed: 0,
            freeSecondsUsed: 0,
            currentPeriodStart: null,
            currentPeriodEnd: null,
          },
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
        couponCode,
      });

      return redirect(confirmationUrl, { target: "_top" });
    }

    if (intent === "increase_cap") {
      const newCapEUR = Number(fd.get("newCapEUR"));
      if (!Number.isFinite(newCapEUR) || newCapEUR <= 0) return fail("Invalid cap amount");

      const { confirmationUrl } = await requestCapIncrease({ shop, admin, newCapEUR });
      return redirect(confirmationUrl, { target: "_top" });
    }

    if (intent === "cancel") {
      await cancelActiveSubscription({ shop, admin, prorate: false });
      return backToBilling({ ok: "1" });
    }

    return fail("Unknown intent");
  } catch (e) {
    if (e instanceof Response) throw e;

    console.error("[billing] action failed", e);
    return fail(asErrorMessage(e));
  }
}

export default function BillingRoute() {
  const { shop, billing, usage, billingError } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  const isBusy = navigation.state === "submitting" || navigation.state === "loading";
  const activeIntent = navigation.formData?.get("intent")?.toString() ?? "";
  const activePlan = navigation.formData?.get("plan")?.toString() ?? "";

  const rawPlanKey: PlanKey = isPlanKey(billing?.plan) ? (billing.plan as PlanKey) : "FREE";
  const pendingPlanKey: PlanKey | null = isPlanKey(billing?.pendingPlan)
    ? (billing.pendingPlan as PlanKey)
    : null;

  const status = String(billing?.status || "NONE").toUpperCase();

  const effectivePlanKey: PlanKey =
    status === "ACTIVE"
      ? rawPlanKey
      : status === "PENDING" && pendingPlanKey
        ? pendingPlanKey
        : "FREE";

  const hasActivePaidPlan = status === "ACTIVE" && effectivePlanKey !== "FREE";
  const plan = PLANS[effectivePlanKey] ?? PLANS.FREE;

  const freeAttemptsUsed = Number(billing?.freeSecondsUsed || 0);
  const freeRemainingAttempts = Math.max(0, PLANS.FREE.includedAttempts - freeAttemptsUsed);

  const includedAttemptsUsed = Number(billing?.includedSecondsUsed || 0);
  const includedRemainingAttempts = Math.max(0, plan.includedAttempts - includedAttemptsUsed);

  const totalIncludedAttempts = effectivePlanKey === "FREE" ? PLANS.FREE.includedAttempts : plan.includedAttempts;
  const remainingAttempts = effectivePlanKey === "FREE" ? freeRemainingAttempts : includedRemainingAttempts;
  const attemptsUsed = Math.max(0, totalIncludedAttempts - remainingAttempts);
  const attemptsProgress = totalIncludedAttempts > 0
    ? Math.min(100, Math.max(0, (attemptsUsed / totalIncludedAttempts) * 100))
    : 0;

  const balanceUsed = usage?.balanceUsed ? Number(usage.balanceUsed.amount) : null;
  const capAmount = usage?.cappedAmount ? Number(usage.cappedAmount.amount) : null;

  const prefillCoupon = String(
    status === "PENDING"
      ? billing?.pendingCouponCode || billing?.appliedCouponCode || ""
      : billing?.appliedCouponCode || ""
  );

  const [coupon, setCoupon] = React.useState(prefillCoupon);

  React.useEffect(() => {
    setCoupon(prefillCoupon);
  }, [prefillCoupon]);

  const currentCouponLabel =
    status === "PENDING" && billing?.pendingCouponCode ? "Pending coupon" : "Coupon";

  return (
    <Page title="Billing" subtitle="Manage your plan and call attempts">
      <Layout>
        <Layout.Section>
          {billingError ? (
            <Banner tone="critical" title="Billing error">
              <p>{billingError}</p>
            </Banner>
          ) : null}

          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    {plan.title}
                  </Text>
                  <Text as="p" tone="subdued">
                    {shop}
                  </Text>
                </BlockStack>
                <Badge tone={badgeToneFromStatus(status)}>
                  {merchantStatusLabel(status, effectivePlanKey)}
                </Badge>
              </InlineStack>

              <Divider />

              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" variant="headingMd">
                    {remainingAttempts} / {totalIncludedAttempts} attempts remaining
                  </Text>
                  <Text as="p" tone="subdued">
                    {attemptsUsed} used
                  </Text>
                </InlineStack>
                <ProgressBar progress={attemptsProgress} size="small" />
                <Text as="p" tone="subdued">
                  One outbound call counts as one attempt. SMS is included with every attempt.
                </Text>
              </BlockStack>

              {prefillCoupon ? (
                <Text as="p">
                  {currentCouponLabel}: <b>{prefillCoupon}</b>
                </Text>
              ) : null}

              {effectivePlanKey !== "FREE" && balanceUsed != null && capAmount != null ? (
                <Text as="p">
                  Usage this cycle: <b>{formatEUR(balanceUsed)}</b> of <b>{formatEUR(capAmount)}</b> cap
                </Text>
              ) : null}

              {hasActivePaidPlan ? (
                <>
                  <Divider />
                  <InlineStack gap="200">
                    <Form method="post">
                      <input type="hidden" name="intent" value="cancel" />
                      <Button tone="critical" submit loading={isBusy && activeIntent === "cancel"}>
                        Cancel subscription
                      </Button>
                    </Form>

                    <Form method="post">
                      <input type="hidden" name="intent" value="increase_cap" />
                      <input
                        type="hidden"
                        name="newCapEUR"
                        value={String((capAmount ?? plan.usageCapEUR) + 50)}
                      />
                      <Button submit loading={isBusy && activeIntent === "increase_cap"}>
                        Increase cap +€50
                      </Button>
                    </Form>
                  </InlineStack>
                </>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingLg">
                  Choose a plan
                </Text>
                <Text as="p" tone="subdued">
                  Pick the number of call attempts that fits your store. SMS is included on every plan.
                </Text>
              </BlockStack>

              <TextField
                label="Coupon code"
                value={coupon}
                onChange={(v) => setCoupon(v)}
                autoComplete="off"
                helpText="Optional. Applied to the subscription fee before you confirm the plan."
              />

              {(["FREE", "STARTER", "PRO", "SCALE", "PAYG"] as PlanKey[]).map((k) => {
                const p = PLANS[k];
                const isSelected =
                  status === "ACTIVE"
                    ? k === rawPlanKey
                    : status === "PENDING" && pendingPlanKey
                      ? k === pendingPlanKey
                      : k === "FREE";

                const badgeText =
                  status === "PENDING" && pendingPlanKey === k
                    ? "Pending"
                    : isSelected
                      ? "Current plan"
                      : null;

                const badgeTone =
                  status === "PENDING" && pendingPlanKey === k
                    ? ("attention" as const)
                    : ("success" as const);

                const isThisSubmitting = isBusy && activeIntent === "select_plan" && activePlan === k;

                return (
                  <Card key={k}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="start">
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingMd">
                            {p.title}
                          </Text>
                          <Text as="p" variant="headingSm">
                            {planPriceLine(k)}
                          </Text>
                          <Text as="p" tone="subdued">
                            {planUsageLine(k)}
                          </Text>
                        </BlockStack>
                        {badgeText ? <Badge tone={badgeTone}>{badgeText}</Badge> : null}
                      </InlineStack>

                      <Form method="post">
                        <input type="hidden" name="intent" value="select_plan" />
                        <input type="hidden" name="plan" value={k} />
                        <input type="hidden" name="coupon" value={coupon.trim()} />
                        <Button
                          submit
                          variant={isSelected ? "secondary" : "primary"}
                          disabled={isSelected}
                          loading={isThisSubmitting}
                        >
                          {isSelected ? "Current plan" : `Choose ${p.title}`}
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
