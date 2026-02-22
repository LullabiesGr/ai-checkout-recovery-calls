// app/routes/app.billing.tsx
import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

import { PLANS, isPlanKey, type PlanKey } from "../lib/billingPlans.shared";
import {
  ensureBillingRow,
  syncBillingFromShopify,
  createSubscriptionForPlan,
  cancelActiveSubscription,
  requestCapIncrease,
} from "../lib/billing.server";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-page": any;
      "s-section": any;
      "s-box": any;
      "s-text": any;
      "s-heading": any;
      "s-badge": any;
      "s-grid": any;
      "s-stack": any;
      "s-divider": any;
      "s-button": any;
      "s-button-group": any;
    }
  }
}

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
  if (s === "ACTIVE") return "success";
  if (s === "PENDING") return "warning";
  if (s === "CANCELLED") return "critical";
  return "info";
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
  const { billing, usage } = useLoaderData<typeof loader>();
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

  const includedUsedSec = Number(billing?.includedSecondsUsed || 0);
  const plan = PLANS[activePlanKey] ?? PLANS.FREE;
  const includedTotalSec = plan.includedMinutes * 60;
  const includedRemainingMin = Math.max(0, Math.floor((includedTotalSec - includedUsedSec) / 60));

  const balanceUsed = usage?.balanceUsed ? Number(usage.balanceUsed.amount) : null;
  const capAmount = usage?.cappedAmount ? Number(usage.cappedAmount.amount) : null;

  return (
    <s-page>
      <s-section>
        <s-box padding="600">
          <s-heading level="1">Billing</s-heading>
          <s-text tone="subdued">Manage plan, included minutes, usage cap.</s-text>
        </s-box>

        <s-grid columns="2" gap="500">
          <s-box padding="600" border="base" borderRadius="400" background="bg-surface">
            <s-stack direction="vertical" gap="300">
              <s-stack direction="horizontal" align="space-between">
                <s-heading level="2">Current plan</s-heading>
                <s-badge tone={badgeToneFromStatus(status)}>{status}</s-badge>
              </s-stack>

              <s-text>
                Plan: <b>{activePlanKey}</b>
              </s-text>

              {activePlanKey === "FREE" ? (
                <s-text>
                  Free minutes remaining: <b>{freeRemainingMin} min</b>
                </s-text>
              ) : (
                <>
                  <s-text>
                    Included minutes remaining (this cycle): <b>{includedRemainingMin} min</b>
                  </s-text>
                  {balanceUsed != null && capAmount != null ? (
                    <s-text>
                      Usage spend (this cycle): <b>{formatEUR(balanceUsed)}</b> / cap <b>{formatEUR(capAmount)}</b>
                    </s-text>
                  ) : null}
                </>
              )}

              <s-divider />

              <s-button-group>
                {activePlanKey !== "FREE" ? (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <s-button tone="critical" type="submit">
                      Cancel subscription
                    </s-button>
                  </fetcher.Form>
                ) : null}

                {activePlanKey !== "FREE" ? (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="increase_cap" />
                    <input type="hidden" name="newCapEUR" value={String((capAmount ?? plan.usageCapEUR) + 50)} />
                    <s-button type="submit">Increase cap +€50</s-button>
                  </fetcher.Form>
                ) : null}
              </s-button-group>
            </s-stack>
          </s-box>

          <s-box padding="600" border="base" borderRadius="400" background="bg-surface">
            <s-stack direction="vertical" gap="400">
              <s-heading level="2">Plans</s-heading>

              <s-stack direction="vertical" gap="300">
                {(["FREE", "STARTER", "PRO", "SCALE", "PAYG"] as PlanKey[]).map((k) => {
                  const p = PLANS[k];
                  const isActive = k === activePlanKey;

                  return (
                    <s-box key={k} padding="500" border="base" borderRadius="300" background="bg-surface">
                      <s-stack direction="vertical" gap="250">
                        <s-stack direction="horizontal" align="space-between">
                          <s-heading level="3">
                            {p.title} ({k})
                          </s-heading>
                          {isActive ? <s-badge tone="success">Active</s-badge> : null}
                        </s-stack>

                        {k === "FREE" ? (
                          <s-text>€0/month • 10 free phone minutes (one-time)</s-text>
                        ) : k === "PAYG" ? (
                          <s-text>
                            €0/month • €{p.overageEURPerMin.toFixed(2)}/min • cap {formatEUR(p.usageCapEUR)}
                          </s-text>
                        ) : (
                          <s-text>
                            {formatEUR(p.recurringMonthlyEUR)}/month • {p.includedMinutes} included min • €
                            {p.overageEURPerMin.toFixed(2)}/min after • cap {formatEUR(p.usageCapEUR)}
                          </s-text>
                        )}

                        <fetcher.Form method="post">
                          <input type="hidden" name="intent" value="select_plan" />
                          <input type="hidden" name="plan" value={k} />
                          <s-button type="submit" disabled={isActive}>
                            {isActive ? "Selected" : "Select"}
                          </s-button>
                        </fetcher.Form>
                      </s-stack>
                    </s-box>
                  );
                })}
              </s-stack>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>
    </s-page>
  );
}