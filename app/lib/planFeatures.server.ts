import db from "../db.server";
import type { BillingPlan } from "@prisma/client";

export const SMS_ALLOWED_PLANS: BillingPlan[] = ["FREE", "STARTER", "PRO", "SCALE", "PAYG"];

export function hasSmsFeature(_plan: BillingPlan | string | null | undefined) {
  return true;
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
  return { plan };
}
