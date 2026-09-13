// app/lib/billingPlans.shared.ts
export type PlanKey = "FREE" | "STARTER" | "PRO" | "SCALE" | "PAYG";

export const BILLING_CURRENCY = "EUR" as const;

export const PLANS: Record<
  PlanKey,
  {
    key: PlanKey;
    title: string;
    recurringMonthlyEUR: number;
    includedAttempts: number;
    isUsageOnly?: boolean;
  }
> = {
  FREE: {
    key: "FREE",
    title: "Free",
    recurringMonthlyEUR: 0,
    includedAttempts: 10,
  },
  STARTER: {
    key: "STARTER",
    title: "Starter",
    recurringMonthlyEUR: 19,
    includedAttempts: 30,
  },
  PRO: {
    key: "PRO",
    title: "Pro",
    recurringMonthlyEUR: 49,
    includedAttempts: 120,
  },
  SCALE: {
    key: "SCALE",
    title: "Scale",
    recurringMonthlyEUR: 99,
    includedAttempts: 250,
  },
  PAYG: {
    key: "PAYG",
    title: "Pay-as-you-go",
    recurringMonthlyEUR: 0,
    includedAttempts: 0,
    isUsageOnly: true,
  },
};

export function isPlanKey(v: any): v is PlanKey {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "FREE" || s === "STARTER" || s === "PRO" || s === "SCALE" || s === "PAYG";
}

// PAYG is retained only to recognize existing subscriptions; it cannot be purchased.
export const EXTRA_ATTEMPT_PACK = { attempts: 25, priceEUR: 20 } as const;
