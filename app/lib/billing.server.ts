// app/lib/billing.server.ts
import db from "../db.server";
import { sessionStorage } from "../shopify.server";
import { BILLING_CURRENCY, PLANS, type PlanKey, isPlanKey } from "./billingPlans.server";

type AdminLike = {
  graphql: (query: string, options?: any) => Promise<any>; // Response in current templates
};

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2025-07";

function moneyInputFromCents(cents: number) {
  const amount = (cents / 100).toFixed(2);
  return { amount, currencyCode: BILLING_CURRENCY };
}

function eurToCents(eur: number) {
  return Math.round(eur * 100);
}

function ceilMinutesFromSeconds(seconds: number) {
  return Math.max(0, Math.ceil(seconds / 60));
}

function idempotencyKeyForCall(callJobId: string) {
  return (`call_${callJobId}`).slice(0, 255);
}

function asErrorMessage(e: unknown) {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

async function graphqlShop(shop: string, query: string, variables: any, admin?: AdminLike) {
  if (admin) {
    const resp = await admin.graphql(query, { variables });
    // Current Shopify templates return a Response, so parse it. If not, just return as-is.
    if (resp && typeof resp.json === "function") return await resp.json();
    return resp;
  }

  const sessionId = `offline_${shop}`;
  const session: any = await sessionStorage.loadSession(sessionId);
  const token = session?.accessToken;
  if (!token) throw new Error(`Missing offline session for ${shop}`);

  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  return await resp.json();
}

export async function ensureBillingRow(shop: string) {
  return db.shopBilling.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

export async function syncBillingFromShopify(args: { shop: string; admin: AdminLike }) {
  const { shop, admin } = args;

  const q = `#graphql
query BillingState {
  currentAppInstallation {
    activeSubscriptions {
      id
      name
      status
      lineItems {
        id
        plan {
          pricingDetails {
            __typename
            ... on AppUsagePricing {
              cappedAmount { amount currencyCode }
              balanceUsed { amount currencyCode }
            }
            ... on AppRecurringPricing {
              interval
              price { amount currencyCode }
            }
          }
        }
      }
    }
  }
}`;

  const json = await graphqlShop(shop, q, {}, admin);
  if (json?.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join(" | "));

  const subs = json?.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const ours = subs.find((s: any) => String(s?.name ?? "").startsWith("AI Checkout Calls - "));

  if (!ours) {
    await db.shopBilling.update({
      where: { shop },
      data: {
        status: "NONE",
        subscriptionId: null,
        usageLineItemId: null,
        recurringLineItemId: null,
        pendingPlan: null,
      },
    });
    return { active: false, usage: null as any };
  }

  const planKey = (String(ours.name).replace("AI Checkout Calls - ", "").trim().toUpperCase()) as PlanKey;
  const normalizedPlan: PlanKey = isPlanKey(planKey) ? planKey : "STARTER";

  const usageLine = (ours.lineItems ?? []).find(
    (li: any) => li?.plan?.pricingDetails?.__typename === "AppUsagePricing"
  );
  const recurLine = (ours.lineItems ?? []).find(
    (li: any) => li?.plan?.pricingDetails?.__typename === "AppRecurringPricing"
  );

  const usageDetails = usageLine?.plan?.pricingDetails ?? null;

  await db.shopBilling.update({
    where: { shop },
    data: {
      plan: normalizedPlan as any,
      pendingPlan: null,
      status: "ACTIVE",
      subscriptionId: ours.id,
      usageLineItemId: usageLine?.id ?? null,
      recurringLineItemId: recurLine?.id ?? null,
    },
  });

  return { active: true, usage: usageDetails };
}

export async function createSubscriptionForPlan(args: {
  shop: string;
  admin: AdminLike;
  plan: PlanKey;
  returnUrl: string;
  test?: boolean;
}) {
  const { shop, admin, plan, returnUrl, test } = args;
  const p = PLANS[plan];
  if (!p) throw new Error("Unknown plan");

  const lineItems: any[] = [];

  if (!p.isUsageOnly && p.recurringMonthlyEUR > 0) {
    lineItems.push({
      plan: {
        appRecurringPricingDetails: {
          interval: "EVERY_30_DAYS",
          price: { amount: p.recurringMonthlyEUR, currencyCode: BILLING_CURRENCY },
        },
      },
    });
  }

  if (p.usageCapEUR > 0) {
    lineItems.push({
      plan: {
        appUsagePricingDetails: {
          terms: usageTermsForPlan(plan),
          cappedAmount: { amount: p.usageCapEUR, currencyCode: BILLING_CURRENCY },
        },
      },
    });
  }

  const m = `#graphql
mutation AppSubscriptionCreate(
  $name: String!
  $returnUrl: URL!
  $lineItems: [AppSubscriptionLineItemInput!]!
  $test: Boolean
  $replacementBehavior: AppSubscriptionReplacementBehavior
) {
  appSubscriptionCreate(
    name: $name
    returnUrl: $returnUrl
    lineItems: $lineItems
    test: $test
    replacementBehavior: $replacementBehavior
  ) {
    userErrors { field message }
    confirmationUrl
    appSubscription {
      id
      lineItems {
        id
        plan {
          pricingDetails {
            __typename
            ... on AppUsagePricing { cappedAmount { amount currencyCode } }
            ... on AppRecurringPricing { interval price { amount currencyCode } }
          }
        }
      }
    }
  }
}`;

  const vars = {
    name: `AI Checkout Calls - ${plan}`,
    returnUrl,
    lineItems,
    test: !!test,
    replacementBehavior: "STANDARD",
  };

  const json = await graphqlShop(shop, m, vars, admin);
  if (json?.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join(" | "));

  const payload = json?.data?.appSubscriptionCreate;
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join(" | "));

  const sub = payload?.appSubscription;
  const usageLine = (sub?.lineItems ?? []).find(
    (li: any) => li?.plan?.pricingDetails?.__typename === "AppUsagePricing"
  );
  const recurLine = (sub?.lineItems ?? []).find(
    (li: any) => li?.plan?.pricingDetails?.__typename === "AppRecurringPricing"
  );

  await db.shopBilling.update({
    where: { shop },
    data: {
      pendingPlan: plan as any,
      status: "PENDING",
      subscriptionId: sub?.id ?? null,
      usageLineItemId: usageLine?.id ?? null,
      recurringLineItemId: recurLine?.id ?? null,
    },
  });

  const confirmationUrl = payload?.confirmationUrl as string | undefined;
  if (!confirmationUrl) throw new Error("Missing confirmationUrl");
  return { confirmationUrl };
}

export async function cancelActiveSubscription(args: { shop: string; admin: AdminLike; prorate?: boolean }) {
  const { shop, admin, prorate } = args;

  const billing = await ensureBillingRow(shop);
  if (!billing.subscriptionId) {
    await db.shopBilling.update({ where: { shop }, data: { status: "NONE" } });
    return;
  }

  const m = `#graphql
mutation CancelSub($id: ID!, $prorate: Boolean) {
  appSubscriptionCancel(id: $id, prorate: $prorate) {
    userErrors { field message }
    appSubscription { id status }
  }
}`;

  const json = await graphqlShop(shop, m, { id: billing.subscriptionId, prorate: !!prorate }, admin);
  if (json?.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join(" | "));

  const payload = json?.data?.appSubscriptionCancel;
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join(" | "));

  await db.shopBilling.update({
    where: { shop },
    data: {
      status: "CANCELLED",
      subscriptionId: null,
      usageLineItemId: null,
      recurringLineItemId: null,
      pendingPlan: null,
    },
  });
}

export async function requestCapIncrease(args: { shop: string; admin: AdminLike; newCapEUR: number }) {
  const { shop, admin, newCapEUR } = args;
  const billing = await ensureBillingRow(shop);
  if (!billing.usageLineItemId) throw new Error("Missing usageLineItemId");

  const m = `#graphql
mutation UpdateCap($id: ID!, $cappedAmount: MoneyInput!) {
  appSubscriptionLineItemUpdate(id: $id, cappedAmount: $cappedAmount) {
    userErrors { field message }
    confirmationUrl
    appSubscription { id }
  }
}`;

  const json = await graphqlShop(
    shop,
    m,
    { id: billing.usageLineItemId, cappedAmount: { amount: newCapEUR, currencyCode: BILLING_CURRENCY } },
    admin
  );
  if (json?.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join(" | "));

  const payload = json?.data?.appSubscriptionLineItemUpdate;
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join(" | "));

  const confirmationUrl = payload?.confirmationUrl as string | undefined;
  if (!confirmationUrl) throw new Error("Missing confirmationUrl");
  return { confirmationUrl };
}

export async function applyBillingForCall(args: {
  shop: string;
  admin?: AdminLike;
  callJobId: string;
  connectedSeconds: number;
  answered: boolean;
  voicemail?: boolean;
}) {
  const { shop, admin, callJobId } = args;

  const rawSeconds = Math.max(0, Math.floor(Number(args.connectedSeconds) || 0));
  const wasAnswered = !!args.answered;
  const wasVoicemail = !!args.voicemail;

  if (!wasAnswered || wasVoicemail || rawSeconds < 15) {
    await db.callCharge.upsert({
      where: { callJobId },
      update: {},
      create: {
        shop,
        callJobId,
        connectedSeconds: rawSeconds,
        minutesBilled: 0,
        amountCents: 0,
        currencyCode: BILLING_CURRENCY,
        idempotencyKey: idempotencyKeyForCall(callJobId),
      },
    });
    return;
  }

  const billableMinutes = Math.max(1, ceilMinutesFromSeconds(rawSeconds));
  const billableSeconds = billableMinutes * 60;

  await db.$transaction(async (tx) => {
    const exists = await tx.callCharge.findUnique({ where: { callJobId } });
    if (exists) return;

    let billing = await tx.shopBilling.upsert({
      where: { shop },
      update: {},
      create: { shop },
    });

    // FREE: 10 one-time minutes
    if (billing.plan === "FREE") {
      const freeTotal = 10 * 60;
      const freeUsed = billing.freeSecondsUsed || 0;
      const freeRemaining = Math.max(0, freeTotal - freeUsed);
      const consumeFree = Math.min(billableSeconds, freeRemaining);

      await tx.shopBilling.update({
        where: { shop },
        data: { freeSecondsUsed: freeUsed + consumeFree },
      });

      await tx.callCharge.create({
        data: {
          shop,
          callJobId,
          connectedSeconds: rawSeconds,
          minutesBilled: billableMinutes,
          amountCents: 0,
          currencyCode: BILLING_CURRENCY,
          idempotencyKey: idempotencyKeyForCall(callJobId),
        },
      });
      return;
    }

    const planKey = billing.plan as unknown as PlanKey;
    const p = PLANS[planKey];

    if (!billing.usageLineItemId) {
      try {
        if (admin) {
          await syncBillingFromShopify({ shop, admin });
        } else {
          const q = `#graphql
          query BillingState {
            currentAppInstallation {
              activeSubscriptions {
                id
                name
                status
                lineItems {
                  id
                  plan {
                    pricingDetails {
                      __typename
                      ... on AppUsagePricing { cappedAmount { amount currencyCode } balanceUsed { amount currencyCode } }
                      ... on AppRecurringPricing { interval price { amount currencyCode } }
                    }
                  }
                }
              }
            }
          }`;
          const j = await graphqlShop(shop, q, {}, undefined);
          if (j?.errors?.length) throw new Error(j.errors.map((e: any) => e.message).join(" | "));

          const subs = j?.data?.currentAppInstallation?.activeSubscriptions ?? [];
          const ours = subs.find((s: any) => String(s?.name ?? "").startsWith("AI Checkout Calls - "));
          if (ours) {
            const usageLine = (ours.lineItems ?? []).find(
              (li: any) => li?.plan?.pricingDetails?.__typename === "AppUsagePricing"
            );
            const recurLine = (ours.lineItems ?? []).find(
              (li: any) => li?.plan?.pricingDetails?.__typename === "AppRecurringPricing"
            );
            await tx.shopBilling.update({
              where: { shop },
              data: {
                status: "ACTIVE",
                subscriptionId: ours.id,
                usageLineItemId: usageLine?.id ?? null,
                recurringLineItemId: recurLine?.id ?? null,
              },
            });
          }
        }
      } catch (e) {
        throw new Error(`Billing sync failed: ${asErrorMessage(e)}`);
      }

      billing = await tx.shopBilling.findUniqueOrThrow({ where: { shop } });
      if (!billing.usageLineItemId) throw new Error("No usage line item after sync");
    }

    const includedTotal = (p.includedMinutes || 0) * 60;
    const includedUsed = billing.includedSecondsUsed || 0;
    const includedRemaining = Math.max(0, includedTotal - includedUsed);

    const consumeIncluded = Math.min(billableSeconds, includedRemaining);
    const chargeableSeconds = Math.max(0, billableSeconds - consumeIncluded);
    const chargeableMinutes = Math.floor(chargeableSeconds / 60);

    await tx.shopBilling.update({
      where: { shop },
      data: { includedSecondsUsed: includedUsed + consumeIncluded },
    });

    const rateCents = eurToCents(p.overageEURPerMin);
    const amountCents = chargeableMinutes * rateCents;

    let usageRecordId: string | null = null;

    if (amountCents > 0) {
      const m = `#graphql
      mutation UsageCharge(
        $description: String!
        $price: MoneyInput!
        $subscriptionLineItemId: ID!
        $idempotencyKey: String
      ) {
        appUsageRecordCreate(
          description: $description
          price: $price
          subscriptionLineItemId: $subscriptionLineItemId
          idempotencyKey: $idempotencyKey
        ) {
          userErrors { field message }
          appUsageRecord { id }
        }
      }`;

      const idempotencyKey = idempotencyKeyForCall(callJobId);

      const json = await graphqlShop(
        shop,
        m,
        {
          description: `${p.title}: ${chargeableMinutes} min overage (call ${callJobId})`,
          price: moneyInputFromCents(amountCents),
          subscriptionLineItemId: billing.usageLineItemId,
          idempotencyKey,
        },
        admin
      );

      if (json?.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join(" | "));

      const payload = json?.data?.appUsageRecordCreate;
      const errs = payload?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e: any) => e.message).join(" | "));
      usageRecordId = payload?.appUsageRecord?.id ?? null;
    }

    await tx.callCharge.create({
      data: {
        shop,
        callJobId,
        connectedSeconds: rawSeconds,
        minutesBilled: billableMinutes,
        amountCents,
        currencyCode: BILLING_CURRENCY,
        usageRecordId,
        idempotencyKey: idempotencyKeyForCall(callJobId),
      },
    });
  });
}

function usageTermsForPlan(plan: PlanKey) {
  const p = PLANS[plan];
  if (plan === "PAYG") {
    return `€${p.overageEURPerMin.toFixed(2)}/minute. Charged per started minute. Answered calls only. Monthly spending limit (cap) applies.`;
  }
  return `Includes ${p.includedMinutes} minutes per billing cycle. Then €${p.overageEURPerMin.toFixed(
    2
  )}/minute. Charged per started minute. Answered calls only. Usage charges are limited by the approved capped amount.`;
}