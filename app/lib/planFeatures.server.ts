import db from "../db.server";
import type { BillingPlan } from "@prisma/client";

export const SMS_ALLOWED_PLANS: BillingPlan[] = ["PRO", "SCALE"];

export function hasSmsFeature(plan: BillingPlan | string | null | undefined) {
  const p = String(plan ?? "").toUpperCase();
  return p === "PRO" || p === "SCALE";
}

export async function getShopPlan(shop: string): Promise<BillingPlan> {
  const row = await db.shopBilling.findUnique({
    where: { shop },
    select: { plan: true },
  });

  return (row?.plan ?? "FREE") as BillingPlan;
}

export async function assertSmsFeature(shop: string) {
  const plan = await getShopPlan(shop);

  if (!hasSmsFeature(plan)) {
    const err = new Error("SMS feature is available only on Pro and Business plans.");
    (err as any).status = 403;
    (err as any).code = "SMS_PLAN_RESTRICTED";
    (err as any).plan = plan;
    throw err;
  }

  return { plan };
}