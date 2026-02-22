export type PlanKey = "FREE" | "STARTER" | "PRO" | "SCALE" | "PAYG";

export const BILLING_CURRENCY = "EUR" as const;

export const PLANS: Record<
  PlanKey,
  {
    key: PlanKey;
    title: string;
    recurringMonthlyEUR: number;   // πάγιο
    includedMinutes: number;       // included minutes / cycle
    overageEURPerMin: number;      // μετά τα included
    usageCapEUR: number;           // cap για usage charges
    isUsageOnly?: boolean;         // PAYG: usage-only subscription
  }
> = {
  FREE: {
    key: "FREE",
    title: "Free",
    recurringMonthlyEUR: 0,
    includedMinutes: 0,
    overageEURPerMin: 0,
    usageCapEUR: 0,
  },
  STARTER: {
    key: "STARTER",
    title: "Starter",
    recurringMonthlyEUR: 19,
    includedMinutes: 30,
    overageEURPerMin: 0.45,
    usageCapEUR: 99,
  },
  PRO: {
    key: "PRO",
    title: "Pro",
    recurringMonthlyEUR: 49,
    includedMinutes: 120,
    overageEURPerMin: 0.35,
    usageCapEUR: 199,
  },
  SCALE: {
    key: "SCALE",
    title: "Scale",
    recurringMonthlyEUR: 99,
    includedMinutes: 400,
    overageEURPerMin: 0.25,
    usageCapEUR: 399,
  },
  PAYG: {
    key: "PAYG",
    title: "Pay-as-you-go",
    recurringMonthlyEUR: 0,
    includedMinutes: 0,
    overageEURPerMin: 0.6,
    usageCapEUR: 100,
    isUsageOnly: true,
  },
};

export function isPlanKey(v: any): v is PlanKey {
  return v === "FREE" || v === "STARTER" || v === "PRO" || v === "SCALE" || v === "PAYG";
}

export function minutesToSeconds(m: number) {
  return Math.max(0, Math.floor(m)) * 60;
}