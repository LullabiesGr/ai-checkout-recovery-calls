// app/lib/billingCoupons.server.ts
import db from "../db.server";
import { type PlanKey } from "./billingPlans.shared";

export type CouponDiscount = {
  code: string;
  percentOff: number; // 1..100
  durationLimitInIntervals: number | null; // null = forever
};

function norm(code: string) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

export async function validateBillingCoupon(args: {
  shop: string;
  plan: PlanKey;
  couponCode: string | null;
}): Promise<CouponDiscount | null> {
  const couponCode = norm(args.couponCode ?? "");
  if (!couponCode) return null;

  const row = await db.billingCoupon.findUnique({ where: { code: couponCode } });
  if (!row) throw new Error("Invalid coupon code");

  if (!row.isActive) throw new Error("Coupon is not active");

  const now = new Date();
  if (row.startsAt && now < row.startsAt) throw new Error("Coupon is not active yet");
  if (row.endsAt && now > row.endsAt) throw new Error("Coupon has expired");

  if (row.plans) {
    const allowed = Array.isArray(row.plans) ? row.plans : [];
    if (allowed.length && !allowed.includes(args.plan)) {
      throw new Error("Coupon is not valid for this plan");
    }
  }

  const percent = Number(row.percentOff);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new Error("Coupon misconfigured (percentOff)");
  }

  const duration =
    row.durationLimitInIntervals == null ? null : Number(row.durationLimitInIntervals);
  if (duration != null && (!Number.isFinite(duration) || duration <= 0)) {
    throw new Error("Coupon misconfigured (durationLimitInIntervals)");
  }

  return {
    code: couponCode,
    percentOff: percent,
    durationLimitInIntervals: duration,
  };
}