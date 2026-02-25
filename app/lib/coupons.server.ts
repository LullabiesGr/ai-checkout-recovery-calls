// app/lib/coupons.server.ts
import type { PlanKey } from "./billingPlans.server";

type CouponKind = "PERCENT" | "AMOUNT_EUR";

type CouponRow = {
  code: string;
  active: boolean | null;

  kind: CouponKind;
  value: number;

  duration_intervals: number | null; // how many billing intervals the discount applies
  applies_to_plan: PlanKey | null;

  starts_at: string | null;  // timestamptz
  expires_at: string | null; // timestamptz

  max_total_uses: number | null;
  max_uses_per_shop: number | null;
};

export type ShopifyAppSubscriptionDiscountInput = {
  durationLimitInIntervals: number;
  value: {
    amount?: number;      // Decimal
    percentage?: number;  // Float
  };
};

function normalizeCouponCode(v: string) {
  return String(v || "").trim().toUpperCase();
}

function getEnv(name: string) {
  const v = process.env[name];
  return v && String(v).trim().length ? String(v).trim() : null;
}

function parseContentRangeTotal(contentRange: string | null) {
  // e.g. "0-0/12"
  if (!contentRange) return null;
  const idx = contentRange.lastIndexOf("/");
  if (idx < 0) return null;
  const n = Number(contentRange.slice(idx + 1));
  return Number.isFinite(n) ? n : null;
}

async function supabaseGetObject<T>(path: string): Promise<T | null> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Coupon system not configured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/vnd.pgrst.object+json",
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase GET failed (${res.status}): ${txt || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function supabaseHeadCount(path: string): Promise<number> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Coupon system not configured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: "HEAD",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase COUNT failed (${res.status}): ${txt || res.statusText}`);
  }

  const total = parseContentRangeTotal(res.headers.get("content-range"));
  if (total == null) throw new Error("Supabase COUNT failed: missing content-range");
  return total;
}

async function supabaseInsert(path: string, body: any): Promise<void> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Coupon system not configured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase INSERT failed (${res.status}): ${txt || res.statusText}`);
  }
}

function nowMs() {
  return Date.now();
}

function parseTsMs(v: string | null) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export async function resolveCouponDiscount(args: {
  shop: string;
  plan: PlanKey;
  couponCodeRaw: string | null | undefined;
}): Promise<{ couponCode: string; discount: ShopifyAppSubscriptionDiscountInput } | null> {
  const couponCode = normalizeCouponCode(args.couponCodeRaw || "");
  if (!couponCode) return null;

  // Tables (Supabase):
  // - billing_coupons (PK: code)
  // - billing_coupon_redemptions
  const coupon = await supabaseGetObject<CouponRow>(
    `billing_coupons?code=eq.${encodeURIComponent(couponCode)}&select=*`
  );

  if (!coupon) throw new Error("Invalid coupon code");
  if (!coupon.active) throw new Error("Invalid coupon code");

  const startMs = parseTsMs(coupon.starts_at);
  const endMs = parseTsMs(coupon.expires_at);

  if (startMs != null && nowMs() < startMs) throw new Error("Coupon not active yet");
  if (endMs != null && nowMs() >= endMs) throw new Error("Coupon expired");

  if (coupon.applies_to_plan && coupon.applies_to_plan !== args.plan) {
    throw new Error("Coupon not valid for this plan");
  }

  // Limits (optional)
  if (coupon.max_total_uses != null) {
    const total = await supabaseHeadCount(
      `billing_coupon_redemptions?coupon_code=eq.${encodeURIComponent(couponCode)}&select=id`
    );
    if (total >= coupon.max_total_uses) throw new Error("Coupon usage limit reached");
  }

  if (coupon.max_uses_per_shop != null) {
    const perShop = await supabaseHeadCount(
      `billing_coupon_redemptions?coupon_code=eq.${encodeURIComponent(couponCode)}&shop=eq.${encodeURIComponent(
        args.shop
      )}&select=id`
    );
    if (perShop >= coupon.max_uses_per_shop) throw new Error("Coupon usage limit reached for this shop");
  }

  const duration = Math.max(1, Math.floor(Number(coupon.duration_intervals || 1)));

  let discountValue: ShopifyAppSubscriptionDiscountInput["value"];
  if (coupon.kind === "PERCENT") {
    const pct = Number(coupon.value);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error("Invalid coupon configuration");
    discountValue = { percentage: pct };
  } else {
    const amt = Number(coupon.value);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("Invalid coupon configuration");
    discountValue = { amount: amt };
  }

  // Write redemption (simple + deterministic).
  // If the merchant cancels approval, you’ll still have a redemption row.
  // If you care, add a “status” column and reconcile via webhooks later.
  await supabaseInsert("billing_coupon_redemptions", {
    coupon_code: couponCode,
    shop: args.shop,
    plan: args.plan,
    created_at: new Date().toISOString(),
  });

  return {
    couponCode,
    discount: {
      durationLimitInIntervals: duration,
      value: discountValue,
    },
  };
}