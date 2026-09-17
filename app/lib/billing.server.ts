// app/lib/billing.server.ts
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { BILLING_CURRENCY, PLANS, type PlanKey, isPlanKey, EXTRA_ATTEMPT_PACK } from "./billingPlans.server";

type AdminLike = {
  graphql: (query: string, options?: any) => Promise<any>;
};

function graphqlErrorMessages(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry: any) => String(entry?.message ?? entry ?? "").trim())
      .filter(Boolean);
  }
  if (typeof value === "object") {
    const direct = String((value as any)?.message ?? "").trim();
    if (direct) return [direct];
    try {
      return [JSON.stringify(value)];
    } catch {
      return [String(value)];
    }
  }
  return [String(value).trim()].filter(Boolean);
}

function throwGraphqlErrors(json: any) {
  const errors = graphqlErrorMessages(json?.errors);
  if (errors.length) throw new Error(errors.join(" | "));
}

function eurToCents(eur: number) {
  return Math.round(eur * 100);
}

function idempotencyKeyForCall(callJobId: string) {
  return (`call_${callJobId}`).slice(0, 255);
}

function normalizeCouponCode(v: unknown) {
  return String(v ?? "").trim().toUpperCase();
}

function extractPlanFromSubscriptionName(name: unknown): PlanKey | null {
  const s = String(name ?? "").trim().toUpperCase();
  if (!s) return null;

  const prefixed = "AI CHECKOUT CALLS - ";
  if (s.startsWith(prefixed)) {
    const maybePlan = s.slice(prefixed.length).trim();
    return isPlanKey(maybePlan) ? maybePlan : null;
  }

  const match = s.match(/\b(FREE|STARTER|PRO|SCALE|PAYG)\b/);
  if (!match) return null;

  const maybePlan = match[1];
  return isPlanKey(maybePlan) ? maybePlan : null;
}

function getSubscriptionLineItems(subscription: any) {
  const lineItems = Array.isArray(subscription?.lineItems) ? subscription.lineItems : [];

  const usageLine =
    lineItems.find((li: any) => li?.plan?.pricingDetails?.__typename === "AppUsagePricing") ?? null;

  const recurringLine =
    lineItems.find((li: any) => li?.plan?.pricingDetails?.__typename === "AppRecurringPricing") ?? null;

  return { usageLine, recurringLine };
}

function pickCurrentSubscription(subs: any[]) {
  const list = Array.isArray(subs) ? subs.filter(Boolean) : [];
  if (!list.length) return null;

  const score = (s: any) => {
    const status = String(s?.status ?? "").toUpperCase();
    const { usageLine, recurringLine } = getSubscriptionLineItems(s);
    const planFromName = extractPlanFromSubscriptionName(s?.name);

    let total = 0;
    if (status === "ACTIVE") total += 100;
    else if (status === "PENDING") total += 80;
    else if (status === "ACCEPTED") total += 60;

    if (planFromName) total += 20;
    if (usageLine) total += 10;
    if (recurringLine) total += 5;

    return total;
  };

  return [...list].sort((a, b) => score(b) - score(a))[0] ?? null;
}

async function graphqlShop(shop: string, query: string, variables: any, admin?: AdminLike) {
  const client = admin ?? (await unauthenticated.admin(shop)).admin;
  const resp = await client.graphql(query, { variables });
  const json = resp && typeof resp.json === "function" ? await resp.json() : resp;
  throwGraphqlErrors(json);
  return json;
}

export async function ensureBillingRow(shop: string) {
  return db.shopBilling.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

type CouponResolve = {
  couponId: string;
  code: string;
  discountInput: any;
};

async function resolveCouponForPlan(args: { shop: string; plan: PlanKey; couponCode: string }) {
  const { shop, plan } = args;
  const code = normalizeCouponCode(args.couponCode);
  if (!code) return null as CouponResolve | null;

  const p = PLANS[plan];
  if (!p || p.isUsageOnly || p.recurringMonthlyEUR <= 0) {
    throw new Error("Coupon applies only to monthly subscription plans");
  }

  const coupon = await db.billingCoupon.findUnique({ where: { code } });
  if (!coupon || !coupon.active) throw new Error("Invalid coupon code");

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) throw new Error("Coupon not active yet");
  if (coupon.endsAt && coupon.endsAt < now) throw new Error("Coupon expired");
  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    throw new Error("Coupon has no remaining redemptions");
  }

  if (coupon.appliesToPlans) {
    const raw = coupon.appliesToPlans as any;
    const list = Array.isArray(raw) ? raw.map((x) => String(x).toUpperCase()) : [];
    if (list.length && !list.includes(plan)) throw new Error("Coupon not valid for this plan");
  }

  const redeemed = await db.billingCouponRedemption.findUnique({
    where: { couponId_shop: { couponId: coupon.id, shop } },
  });
  if (redeemed) throw new Error("Coupon already used on this shop");

  const type = String(coupon.type || "").toUpperCase();
  let value: any;

  if (type === "PERCENT") {
    const percentage = Number(coupon.percentage ?? 0);
    if (!(percentage > 0 && percentage < 1)) {
      throw new Error("Coupon misconfigured (percentage)");
    }
    value = { percentage };
  } else if (type === "AMOUNT") {
    const amount = Number(coupon.amountOffEUR ?? 0);
    if (!(amount > 0)) throw new Error("Coupon misconfigured (amount)");
    value = { amount: Math.min(amount, p.recurringMonthlyEUR) };
  } else {
    throw new Error("Coupon misconfigured (type)");
  }

  const discountInput: any = { value };
  if (coupon.durationLimitInIntervals != null && coupon.durationLimitInIntervals > 0) {
    discountInput.durationLimitInIntervals = coupon.durationLimitInIntervals;
  }

  return { couponId: coupon.id, code: coupon.code, discountInput } as CouponResolve;
}

export async function syncBillingFromShopify(args: { shop: string; admin?: AdminLike }) {
  const { shop, admin } = args;

  const q = `#graphql
query BillingState {
  currentAppInstallation {
    activeSubscriptions {
      id
      name
      status
      currentPeriodEnd
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
  throwGraphqlErrors(json);

  const subs = json?.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const ours = pickCurrentSubscription(subs);

  const usageDetails = (() => {
    if (!ours) return null;
    const { usageLine } = getSubscriptionLineItems(ours);
    return usageLine?.plan?.pricingDetails ?? null;
  })();

  await ensureBillingRow(shop);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shop" FROM "ShopBilling" WHERE "shop" = ${shop} FOR UPDATE`;
    const row = await tx.shopBilling.upsert({
      where: { shop },
      update: {},
      create: { shop },
    });

    if (!ours) {
      const now = new Date();
      const existingFreePeriodEnd = row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null;
      const enteringFree = row.plan !== "FREE";
      const freeCycleExpired = !existingFreePeriodEnd || existingFreePeriodEnd.getTime() <= now.getTime();
      const resetFreeAttempts = enteringFree || freeCycleExpired;
      const nextFreePeriodEnd = resetFreeAttempts
        ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
        : existingFreePeriodEnd;

      await tx.shopBilling.update({
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
          freeSecondsUsed: resetFreeAttempts ? 0 : row.freeSecondsUsed,
          currentPeriodStart: resetFreeAttempts ? now : row.currentPeriodStart,
          currentPeriodEnd: nextFreePeriodEnd,
        },
      });
      return;
    }

    const { usageLine, recurringLine } = getSubscriptionLineItems(ours);
    const status = String(ours.status ?? "ACTIVE").toUpperCase();

    const detectedPlan = extractPlanFromSubscriptionName(ours.name);
    const currentRowPlan = isPlanKey(row.plan) ? (row.plan as PlanKey) : "FREE";

    const normalizedPlan: PlanKey =
      detectedPlan ??
      (currentRowPlan !== "FREE"
        ? currentRowPlan
        : recurringLine
          ? "STARTER"
          : usageLine
            ? "PAYG"
            : "FREE");

    const nextPeriodEnd = ours?.currentPeriodEnd ? new Date(ours.currentPeriodEnd) : null;
    const previousPeriodEnd = row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null;
    const planChanged = normalizedPlan !== currentRowPlan;
    const billingCycleChanged = Boolean(
      status === "ACTIVE" &&
      nextPeriodEnd &&
      (!previousPeriodEnd || previousPeriodEnd.getTime() !== nextPeriodEnd.getTime())
    );
    const resetIncludedAttempts = planChanged || billingCycleChanged;

    await tx.shopBilling.update({
      where: { shop },
      data: {
        plan: normalizedPlan as any,
        pendingPlan: null,
        status: status as any,
        subscriptionId: ours.id,
        usageLineItemId: usageLine?.id ?? null,
        recurringLineItemId: recurringLine?.id ?? null,
        includedSecondsUsed: resetIncludedAttempts ? 0 : row.includedSecondsUsed,
        freeSecondsUsed: normalizedPlan === "FREE" && planChanged ? 0 : row.freeSecondsUsed,
        currentPeriodStart: resetIncludedAttempts ? new Date() : row.currentPeriodStart,
        currentPeriodEnd: nextPeriodEnd,
      },
    });

    if (status === "ACTIVE" && row.pendingCouponId && row.pendingPlan === normalizedPlan) {
      const already = await tx.billingCouponRedemption.findUnique({
        where: { couponId_shop: { couponId: row.pendingCouponId, shop } },
      });

      if (!already) {
        await tx.billingCouponRedemption.create({
          data: {
            couponId: row.pendingCouponId,
            shop,
            subscriptionId: ours.id,
          },
        });

        await tx.billingCoupon.update({
          where: { id: row.pendingCouponId },
          data: { redeemedCount: { increment: 1 } },
        });
      }

      await tx.shopBilling.update({
        where: { shop },
        data: {
          appliedCouponCode: row.pendingCouponCode ?? row.appliedCouponCode ?? null,
          pendingCouponId: null,
          pendingCouponCode: null,
        },
      });
    }
  });

  return { active: !!ours, usage: usageDetails };
}

export async function createSubscriptionForPlan(args: {
  shop: string;
  admin: AdminLike;
  plan: PlanKey;
  returnUrl: string;
  test?: boolean;
  couponCode?: string;
}) {
  const { shop, admin, plan, returnUrl, test } = args;
  const p = PLANS[plan];
  if (!p || plan === "PAYG" || plan === "FREE") throw new Error("Choose a monthly plan");

  const coupon = await resolveCouponForPlan({
    shop,
    plan,
    couponCode: args.couponCode ?? "",
  });

  const lineItems: any[] = [];

  if (!p.isUsageOnly && p.recurringMonthlyEUR > 0) {
    const recurring: any = {
      interval: "EVERY_30_DAYS",
      price: { amount: p.recurringMonthlyEUR, currencyCode: BILLING_CURRENCY },
    };

    if (coupon) {
      recurring.discount = coupon.discountInput;
    }

    lineItems.push({
      plan: {
        appRecurringPricingDetails: recurring,
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
  throwGraphqlErrors(json);

  const payload = json?.data?.appSubscriptionCreate;
  const errs = graphqlErrorMessages(payload?.userErrors);
  if (errs.length) {
    throw new Error(errs.join(" | "));
  }

  await db.shopBilling.update({
    where: { shop },
    data: {
      pendingPlan: plan as any,

      pendingCouponId: coupon?.couponId ?? null,
      pendingCouponCode: coupon?.code ?? null,
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
      },
    });
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
  throwGraphqlErrors(json);

  const payload = json?.data?.appSubscriptionCancel;
  const errs = graphqlErrorMessages(payload?.userErrors);
  if (errs.length) {
    throw new Error(errs.join(" | "));
  }

  try {
    await syncBillingFromShopify({ shop, admin });
  } catch {
    await db.shopBilling.update({
      where: { shop },
      data: {
        plan: "FREE",
        status: "CANCELLED",
        subscriptionId: null,
        usageLineItemId: null,
        recurringLineItemId: null,
        pendingPlan: null,
        pendingCouponId: null,
        pendingCouponCode: null,
        appliedCouponCode: null,
      },
    });
  }
}

// All new calls consume prepaid attempts before the provider is contacted.
export async function getAttemptAvailability(shop: string) {
  const billing = await ensureBillingRow(shop);
  const key = isPlanKey(billing.plan) ? billing.plan : "FREE";
  const active = key !== "PAYG" && (key === "FREE" || (billing.status === "ACTIVE" && !!billing.currentPeriodEnd && billing.currentPeriodEnd > new Date()));
  const included = PLANS[key].includedAttempts;
  const used = key === "FREE" ? billing.freeSecondsUsed : billing.includedSecondsUsed;
  const remainingIncluded = active ? Math.max(0, included - used) : 0;
  return { plan: key, included, used, remainingIncluded, extraAttempts: billing.extraAttempts,
    allowed: active && remainingIncluded + billing.extraAttempts > 0 };
}

export async function reserveAttempt(shop: string, callJobId: string) {
  // Refresh subscription status and billing-cycle allowance using Shopify's background Admin client.
  await syncBillingFromShopify({ shop });
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shop" FROM "ShopBilling" WHERE "shop" = ${shop} FOR UPDATE`;
    const job = await tx.callJob.findFirst({ where: { id: callJobId, shop } });
    if (!job || job.providerCallId) throw new Error("CALL_ALREADY_STARTED_OR_INVALID");
    if (await tx.callCharge.findUnique({ where: { callJobId } })) throw new Error("ATTEMPT_ALREADY_RESERVED");
    const row = await tx.shopBilling.findUniqueOrThrow({ where: { shop } });
    const key = isPlanKey(row.plan) ? row.plan : "FREE";
    if (key === "PAYG") throw new Error("MONTHLY_PLAN_REQUIRED");
    if (key !== "FREE" && (row.status !== "ACTIVE" || !row.currentPeriodEnd || row.currentPeriodEnd <= new Date())) {
      throw new Error("ACTIVE_SUBSCRIPTION_REQUIRED");
    }
    const used = key === "FREE" ? row.freeSecondsUsed : row.includedSecondsUsed;
    const included = used < PLANS[key].includedAttempts;
    if (!included && row.extraAttempts <= 0) throw new Error("ATTEMPT_LIMIT_REACHED");
    const source = included ? (key === "FREE" ? "FREE" : "INCLUDED") : "EXTRA";
    await tx.shopBilling.update({ where: { shop }, data: source === "FREE"
      ? { freeSecondsUsed: { increment: 1 } } : source === "INCLUDED"
      ? { includedSecondsUsed: { increment: 1 } } : { extraAttempts: { decrement: 1 } } });
    await tx.callCharge.create({ data: { shop, callJobId, connectedSeconds: 0, minutesBilled: 0,
      amountCents: 0, currencyCode: BILLING_CURRENCY, idempotencyKey: idempotencyKeyForCall(callJobId),
      attemptSource: source, attemptPeriodEnd: row.currentPeriodEnd } });
  });
}

export const SMS_PER_CUSTOMER_LIMIT = 2;

export async function getSmsCustomerAllowance(shop: string, customerKey: string) {
  const used = await db.smsDelivery.count({
    where: { shop, customerKey, status: { in: ["RESERVED", "SENT"] } },
  });
  return {
    limit: SMS_PER_CUSTOMER_LIMIT,
    used,
    available: Math.max(0, SMS_PER_CUSTOMER_LIMIT - used),
  };
}

export async function reserveSmsAttempt(args: {
  shop: string;
  checkoutId: string;
  customerKey: string;
  source: "MANUAL" | "AUTOMATIC";
  idempotencyKey: string;
}) {
  await syncBillingFromShopify({ shop: args.shop });

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shop" FROM "ShopBilling" WHERE "shop" = ${args.shop} FOR UPDATE`;

    const existing = await tx.smsDelivery.findUnique({ where: { idempotencyKey: args.idempotencyKey } });
    if (existing?.shop !== undefined && existing.shop !== args.shop) throw new Error("INVALID_SMS_REQUEST");
    if (existing?.status === "SENT") {
      return { delivery: existing, alreadySent: true };
    }
    if (existing?.status === "RESERVED") throw new Error("SMS_SEND_IN_PROGRESS");

    const customerSmsCount = await tx.smsDelivery.count({
      where: {
        shop: args.shop,
        customerKey: args.customerKey,
        status: { in: ["RESERVED", "SENT"] },
      },
    });
    if (customerSmsCount >= SMS_PER_CUSTOMER_LIMIT) throw new Error("SMS_CUSTOMER_LIMIT_REACHED");

    const row = await tx.shopBilling.findUniqueOrThrow({ where: { shop: args.shop } });
    const key = isPlanKey(row.plan) ? row.plan : "FREE";
    if (key === "PAYG") throw new Error("MONTHLY_PLAN_REQUIRED");
    if (key !== "FREE" && (row.status !== "ACTIVE" || !row.currentPeriodEnd || row.currentPeriodEnd <= new Date())) {
      throw new Error("ACTIVE_SUBSCRIPTION_REQUIRED");
    }

    const used = key === "FREE" ? row.freeSecondsUsed : row.includedSecondsUsed;
    const included = used < PLANS[key].includedAttempts;
    if (!included && row.extraAttempts <= 0) throw new Error("ATTEMPT_LIMIT_REACHED");
    const attemptSource = included ? (key === "FREE" ? "FREE" : "INCLUDED") : "EXTRA";

    await tx.shopBilling.update({
      where: { shop: args.shop },
      data:
        attemptSource === "FREE"
          ? { freeSecondsUsed: { increment: 1 } }
          : attemptSource === "INCLUDED"
            ? { includedSecondsUsed: { increment: 1 } }
            : { extraAttempts: { decrement: 1 } },
    });

    const data = {
      shop: args.shop,
      checkoutId: args.checkoutId,
      customerKey: args.customerKey,
      source: args.source,
      status: "RESERVED",
      attemptSource,
      attemptPeriodEnd: row.currentPeriodEnd,
      messageId: null,
      sender: null,
      error: null,
      sentAt: null,
    };
    const delivery = existing
      ? await tx.smsDelivery.update({ where: { id: existing.id }, data })
      : await tx.smsDelivery.create({ data: { ...data, idempotencyKey: args.idempotencyKey } });

    return { delivery, alreadySent: false };
  });
}

export async function completeSmsAttempt(args: { deliveryId: string; messageId?: string | null; sender: string }) {
  return db.smsDelivery.updateMany({
    where: { id: args.deliveryId, status: "RESERVED" },
    data: {
      status: "SENT",
      messageId: args.messageId ?? null,
      sender: args.sender,
      error: null,
      sentAt: new Date(),
    },
  });
}

export async function releaseSmsAttempt(args: { shop: string; deliveryId: string; error: string }) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shop" FROM "ShopBilling" WHERE "shop" = ${args.shop} FOR UPDATE`;
    const delivery = await tx.smsDelivery.findFirst({
      where: { id: args.deliveryId, shop: args.shop, status: "RESERVED" },
    });
    if (!delivery) return;

    const row = await tx.shopBilling.findUniqueOrThrow({ where: { shop: args.shop } });
    const sameCycle = row.currentPeriodEnd?.getTime() === delivery.attemptPeriodEnd?.getTime();
    if (delivery.attemptSource === "EXTRA") {
      await tx.shopBilling.update({ where: { shop: args.shop }, data: { extraAttempts: { increment: 1 } } });
    } else if (sameCycle) {
      const field = delivery.attemptSource === "FREE" ? "freeSecondsUsed" : "includedSecondsUsed";
      await tx.shopBilling.update({ where: { shop: args.shop }, data: { [field]: { decrement: 1 } } });
    }

    await tx.smsDelivery.update({
      where: { id: delivery.id },
      data: { status: "FAILED", error: args.error.slice(0, 1000) },
    });
  });
}

// Only a definitive provider rejection releases a reservation. Ambiguous network errors retain it.
export async function releaseAttempt(shop: string, callJobId: string) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shop" FROM "ShopBilling" WHERE "shop" = ${shop} FOR UPDATE`;
    const charge = await tx.callCharge.findUnique({ where: { callJobId } });
    if (!charge || charge.shop !== shop || charge.attemptSource === "LEGACY") return;
    const row = await tx.shopBilling.findUniqueOrThrow({ where: { shop } });
    const sameCycle = row.currentPeriodEnd?.getTime() === charge.attemptPeriodEnd?.getTime();
    if (charge.attemptSource === "EXTRA") {
      await tx.shopBilling.update({ where: { shop }, data: { extraAttempts: { increment: 1 } } });
    } else if (sameCycle) {
      const field = charge.attemptSource === "FREE" ? "freeSecondsUsed" : "includedSecondsUsed";
      await tx.shopBilling.update({ where: { shop }, data: { [field]: { decrement: 1 } } });
    }
    await tx.callCharge.delete({ where: { callJobId } });
  });
}

export async function applyBillingForCall(args: {
  shop: string; admin?: AdminLike; callJobId: string; connectedSeconds: number; answered: boolean; voicemail?: boolean;
}) {
  // Webhook replays update analytics only. No automatic overage charges are created.
  await db.callCharge.updateMany({ where: { shop: args.shop, callJobId: args.callJobId },
    data: { connectedSeconds: Math.max(0, Math.floor(Number(args.connectedSeconds) || 0)) } });
}

export async function createAttemptPurchase(args: { shop: string; admin: AdminLike; returnUrl: string; test: boolean }) {
  await syncBillingFromShopify(args);
  const row = await ensureBillingRow(args.shop);
  if (row.status !== "ACTIVE" || !["STARTER", "PRO", "SCALE"].includes(row.plan)) {
    throw new Error("Choose a monthly plan before buying extra attempts");
  }
  const purchase = await db.attemptPurchase.create({ data: { shop: args.shop,
    attempts: EXTRA_ATTEMPT_PACK.attempts, amountCents: eurToCents(EXTRA_ATTEMPT_PACK.priceEUR), test: args.test } });
  const returnUrl = new URL(args.returnUrl);
  returnUrl.searchParams.set("purchase", purchase.id);
  const json = await graphqlShop(args.shop, `#graphql
    mutation BuyAttempts($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean!) {
      appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
        appPurchaseOneTime { id } confirmationUrl userErrors { message }
      }
    }`, { name: `CartEcho: ${purchase.attempts} extra attempts`, price: { amount: EXTRA_ATTEMPT_PACK.priceEUR, currencyCode: BILLING_CURRENCY },
      returnUrl: returnUrl.toString(), test: args.test }, args.admin);
  const payload = json?.data?.appPurchaseOneTimeCreate;
  const errors = [
    ...graphqlErrorMessages(json?.errors),
    ...graphqlErrorMessages(payload?.userErrors),
  ];
  if (errors.length) throw new Error(errors.join(" | "));
  if (!payload?.appPurchaseOneTime?.id || !payload.confirmationUrl) throw new Error("Purchase confirmation unavailable");
  await db.attemptPurchase.update({ where: { id: purchase.id }, data: { shopifyPurchaseId: payload.appPurchaseOneTime.id } });
  return { confirmationUrl: payload.confirmationUrl as string };
}

export async function confirmAttemptPurchase(shop: string, admin: AdminLike, id: string) {
  const purchase = await db.attemptPurchase.findFirst({ where: { id, shop } });
  if (!purchase?.shopifyPurchaseId) throw new Error("Purchase not found");
  if (purchase.creditedAt) return;
  const json = await graphqlShop(shop, `#graphql
    query VerifyAttemptPurchase($id: ID!) {
      node(id: $id) { ... on AppPurchaseOneTime { id status test price { amount currencyCode } } }
    }`, { id: purchase.shopifyPurchaseId }, admin);
  throwGraphqlErrors(json);
  const remote = json?.data?.node;
  if (remote?.status !== "ACTIVE") throw new Error("Purchase has not been approved; no attempts were added");
  if (remote.id !== purchase.shopifyPurchaseId || remote.test !== purchase.test || remote.price?.currencyCode !== BILLING_CURRENCY ||
      eurToCents(Number(remote.price?.amount)) !== purchase.amountCents) throw new Error("Purchase verification failed");
  await db.$transaction(async (tx) => {
    const claimed = await tx.attemptPurchase.updateMany({ where: { id, shop, creditedAt: null }, data: { creditedAt: new Date() } });
    if (claimed.count) await tx.shopBilling.update({ where: { shop }, data: { extraAttempts: { increment: purchase.attempts } } });
  });
}

export async function reconcileAttemptPurchases(shop: string, admin: AdminLike) {
  const pending = await db.attemptPurchase.findMany({ where: { shop, creditedAt: null, shopifyPurchaseId: { not: null } }, orderBy: { createdAt: "desc" }, take: 50 });
  for (const purchase of pending) {
    try { await confirmAttemptPurchase(shop, admin, purchase.id); } catch { /* Unapproved purchases grant nothing; retry on next visit. */ }
  }
}
