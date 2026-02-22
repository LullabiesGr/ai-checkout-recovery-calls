// app/routes/app.billing.tsx
import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
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
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureBillingRow(shop);
  const sync = await syncBillingFromShopify({ shop, admin });
  const billing = await db.shopBilling.findUnique({ where: { shop } });

  return {
    shop,
    billing,
    usage: sync?.usage ?? null,
  } satisfies LoaderData;
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "select_plan") {
    const plan = String(form.get("plan") || "").toUpperCase();
    if (!isPlanKey(plan)) throw new Error("Invalid plan");

    const u = new URL(request.url);
    u.pathname = "/app/billing";
    const returnUrl = u.toString();

    if (plan === "FREE") {
      await cancelActiveSubscription({ shop, admin, prorate: false });
      await db.shopBilling.update({
        where: { shop },
        data: { plan: "FREE", status: "NONE", pendingPlan: null },
      });
      return { ok: true };
    }

    const { confirmationUrl } = await createSubscriptionForPlan({
      shop,
      admin,
      plan: plan as PlanKey,
      returnUrl,
      test: true,
    });

    return { confirmationUrl };
  }

  if (intent === "increase_cap") {
    const newCapEUR = Number(form.get("newCapEUR"));
    if (!Number.isFinite(newCapEUR) || newCapEUR <= 0) throw new Error("Invalid cap");

    const { confirmationUrl } = await requestCapIncrease({ shop, admin, newCapEUR });
    return { confirmationUrl };
  }

  if (intent === "cancel") {
    await cancelActiveSubscription({ shop, admin, prorate: false });
    return { ok: true };
  }

  throw new Error("Unknown intent");
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

function topRedirect(url: string) {
  if (typeof window === "undefined") return;
  try {
    if (window.top) window.top.location.assign(url);
    else window.location.assign(url);
  } catch {
    window.location.assign(url);
  }
}

export default function BillingRoute() {
  const { shop, billing, usage } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<any>();

  React.useEffect(() => {
    const url = fetcher.data?.confirmationUrl;
    if (!url) return;
    topRedirect(url);
  }, [fetcher.data]);

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

  const isBusy = fetcher.state === "submitting" || fetcher.state === "loading";

  return (
    <Page title="Billing" subtitle={shop}>
      <Layout>
        <Layout.Section>
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
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <Button tone="critical" submit loading={isBusy}>
                      Cancel subscription
                    </Button>
                  </fetcher.Form>
                ) : null}

                {activePlanKey !== "FREE" ? (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="increase_cap" />
                    <input type="hidden" name="newCapEUR" value={String((capAmount ?? plan.usageCapEUR) + 50)} />
                    <Button submit loading={isBusy}>
                      Increase cap +€50
                    </Button>
                  </fetcher.Form>
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

                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="select_plan" />
                        <input type="hidden" name="plan" value={k} />
                        <Button submit disabled={isActive} loading={isBusy}>
                          {isActive ? "Selected" : "Select"}
                        </Button>
                      </fetcher.Form>
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