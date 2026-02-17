// app/routes/app.settings.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

/* =========================
   Types
   ========================= */
type Tone = "neutral" | "friendly" | "premium" | "urgent";
type Goal = "complete_checkout" | "qualify_and_follow_up" | "support_only";
type OfferRule = "ask_only" | "price_objection" | "after_first_objection" | "always";

type ExtrasRow = {
  tone: string | null;
  goal: string | null;
  max_call_seconds: number | null;
  max_followup_questions: number | null;

  discount_enabled: boolean | null;
  max_discount_percent: number | null;
  offer_rule: string | null;
  min_cart_value_for_discount: number | null;
  coupon_prefix: string | null;
  coupon_validity_hours: number | null;
  free_shipping_enabled: boolean | null;

  followup_email_enabled: boolean | null;
  followup_sms_enabled: boolean | null;
};

type LoaderData = {
  shop: string;
  saved?: boolean;
  settings: {
    enabled: boolean;
    delayMinutes: number;
    maxAttempts: number;
    retryMinutes: number;
    minOrderValue: number;
    currency: string;
    callWindowStart: string;
    callWindowEnd: string;

    // playbook (stored in SQL columns on "Settings")
    tone: Tone;
    goal: Goal;
    maxCallSeconds: number;
    maxFollowupQuestions: number;

    discountEnabled: boolean;
    maxDiscountPercent: number;
    offerRule: OfferRule;
    minCartValueForDiscount: number | null;
    couponPrefix: string | null;
    couponValidityHours: number;
    freeShippingEnabled: boolean;

    followupEmailEnabled: boolean;
    followupSmsEnabled: boolean;

    // merchant custom prompt (Prisma column: userPrompt)
    userPrompt: string;
  };
};

/* =========================
   Helpers
   ========================= */
function toInt(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}
function toFloat(v: FormDataEntryValue | null, fallback: number) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}
function toFloatOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function toBool(v: FormDataEntryValue | null) {
  const s = String(v ?? "");
  return s === "on" || s === "true" || s === "1";
}
function safeHHMM(v: FormDataEntryValue | null, fallback: string) {
  const s = String(v ?? "").trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : fallback;
}
function clamp(n: number, min: number, max: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function pickTone(v: any): Tone {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "friendly" || s === "premium" || s === "urgent" || s === "neutral") return s as Tone;
  return "neutral";
}
function pickGoal(v: any): Goal {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "qualify_and_follow_up" || s === "support_only" || s === "complete_checkout") return s as Goal;
  return "complete_checkout";
}
function pickOfferRule(v: any): OfferRule {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "price_objection" || s === "after_first_objection" || s === "always" || s === "ask_only") return s as OfferRule;
  return "ask_only";
}
function pickCurrency(v: any): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "USD" || s === "EUR" || s === "GBP") return s;
  return "USD";
}

async function readSettingsExtras(shop: string): Promise<ExtrasRow | null> {
  const rows = await (db as any).$queryRaw<ExtrasRow[]>`
    select
      tone,
      goal,
      max_call_seconds,
      max_followup_questions,
      discount_enabled,
      max_discount_percent,
      offer_rule,
      min_cart_value_for_discount,
      coupon_prefix,
      coupon_validity_hours,
      free_shipping_enabled,
      followup_email_enabled,
      followup_sms_enabled
    from public."Settings"
    where shop = ${shop}
    limit 1
  `;
  return rows?.[0] ?? null;
}

async function writeSettingsExtras(
  shop: string,
  data: {
    tone: Tone;
    goal: Goal;
    maxCallSeconds: number;
    maxFollowupQuestions: number;

    discountEnabled: boolean;
    maxDiscountPercent: number;
    offerRule: OfferRule;
    minCartValueForDiscount: number | null;
    couponPrefix: string | null;
    couponValidityHours: number;
    freeShippingEnabled: boolean;

    followupEmailEnabled: boolean;
    followupSmsEnabled: boolean;
  }
) {
  await (db as any).$executeRaw`
    update public."Settings"
    set
      tone = ${data.tone},
      goal = ${data.goal},
      max_call_seconds = ${data.maxCallSeconds},
      max_followup_questions = ${data.maxFollowupQuestions},
      discount_enabled = ${data.discountEnabled},
      max_discount_percent = ${data.maxDiscountPercent},
      offer_rule = ${data.offerRule},
      min_cart_value_for_discount = ${data.minCartValueForDiscount},
      coupon_prefix = ${data.couponPrefix},
      coupon_validity_hours = ${data.couponValidityHours},
      free_shipping_enabled = ${data.freeShippingEnabled},
      followup_email_enabled = ${data.followupEmailEnabled},
      followup_sms_enabled = ${data.followupSmsEnabled}
    where shop = ${shop}
  `;
}

/* =========================
   Loader / Action
   ========================= */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const base = await ensureSettings(shop);
  const b: any = base as any;
  const extras = await readSettingsExtras(shop);

  const settings: LoaderData["settings"] = {
    enabled: Boolean(base.enabled),
    delayMinutes: Number(base.delayMinutes ?? 30),
    maxAttempts: Number(base.maxAttempts ?? 2),
    retryMinutes: Number(base.retryMinutes ?? 180),
    minOrderValue: Number(base.minOrderValue ?? 0),
    currency: String(base.currency ?? "USD"),
    callWindowStart: String(b.callWindowStart ?? "09:00"),
    callWindowEnd: String(b.callWindowEnd ?? "19:00"),

    tone: pickTone(extras?.tone ?? "neutral"),
    goal: pickGoal(extras?.goal ?? "complete_checkout"),
    maxCallSeconds: clamp(Number(extras?.max_call_seconds ?? 120), 45, 300),
    maxFollowupQuestions: clamp(Number(extras?.max_followup_questions ?? 1), 0, 3),

    discountEnabled: Boolean(extras?.discount_enabled ?? false),
    maxDiscountPercent: clamp(Number(extras?.max_discount_percent ?? 10), 0, 50),
    offerRule: pickOfferRule(extras?.offer_rule ?? "ask_only"),
    minCartValueForDiscount: extras?.min_cart_value_for_discount == null ? null : Number(extras.min_cart_value_for_discount),
    couponPrefix: (String(extras?.coupon_prefix ?? "").trim() ? String(extras?.coupon_prefix).trim() : null),
    couponValidityHours: clamp(Number(extras?.coupon_validity_hours ?? 24), 1, 168),
    freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),

    followupEmailEnabled: Boolean(extras?.followup_email_enabled ?? true),
    followupSmsEnabled: Boolean(extras?.followup_sms_enabled ?? false),

    userPrompt: String((base as any).userPrompt ?? ""),
  };

  return { shop, settings } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const base = await ensureSettings(shop);
  const b: any = base as any;
  const extras = await readSettingsExtras(shop);

  const fd = await request.formData();

  const enabled = String(fd.get("enabled") ?? "") === "on";
  const delayMinutes = toInt(fd.get("delayMinutes"), Number(base.delayMinutes ?? 30));
  const maxAttempts = toInt(fd.get("maxAttempts"), Number(base.maxAttempts ?? 2));
  const retryMinutes = toInt(fd.get("retryMinutes"), Number(base.retryMinutes ?? 180));
  const minOrderValue = toFloat(fd.get("minOrderValue"), Number(base.minOrderValue ?? 0));
  const currency = pickCurrency(fd.get("currency") ?? base.currency ?? "USD");
  const callWindowStart = safeHHMM(fd.get("callWindowStart"), String(b.callWindowStart ?? "09:00"));
  const callWindowEnd = safeHHMM(fd.get("callWindowEnd"), String(b.callWindowEnd ?? "19:00"));

  const tone = pickTone(fd.get("tone") ?? extras?.tone ?? "neutral");
  const goal = pickGoal(fd.get("goal") ?? extras?.goal ?? "complete_checkout");
  const maxCallSeconds = clamp(toInt(fd.get("maxCallSeconds"), Number(extras?.max_call_seconds ?? 120)), 45, 300);
  const maxFollowupQuestions = clamp(
    toInt(fd.get("maxFollowupQuestions"), Number(extras?.max_followup_questions ?? 1)),
    0,
    3
  );

  const discountEnabled = toBool(fd.get("discountEnabled"));
  const maxDiscountPercent = clamp(
    toInt(fd.get("maxDiscountPercent"), Number(extras?.max_discount_percent ?? 10)),
    0,
    50
  );
  const offerRule = pickOfferRule(fd.get("offerRule") ?? extras?.offer_rule ?? "ask_only");
  const minCartValueForDiscount = toFloatOrNull(fd.get("minCartValueForDiscount"));
  const couponPrefixRaw = String(fd.get("couponPrefix") ?? "").trim();
  const couponPrefix = couponPrefixRaw ? couponPrefixRaw.slice(0, 12) : null;
  const couponValidityHours = clamp(
    toInt(fd.get("couponValidityHours"), Number(extras?.coupon_validity_hours ?? 24)),
    1,
    168
  );
  const freeShippingEnabled = toBool(fd.get("freeShippingEnabled"));

  const followupEmailEnabled = toBool(fd.get("followupEmailEnabled"));
  const followupSmsEnabled = toBool(fd.get("followupSmsEnabled"));

  const userPrompt = String(fd.get("userPrompt") ?? "").trim();

  // Prisma fields
  await db.settings.update({
    where: { shop },
    data: {
      enabled,
      delayMinutes,
      maxAttempts,
      retryMinutes,
      minOrderValue,
      currency,
      callWindowStart,
      callWindowEnd,
      userPrompt,

      // keep these null (global ENV, not per user)
      vapiAssistantId: null,
      vapiPhoneNumberId: null,
    } as any,
  });

  // SQL-only extra columns
  await writeSettingsExtras(shop, {
    tone,
    goal,
    maxCallSeconds,
    maxFollowupQuestions,
    discountEnabled,
    maxDiscountPercent,
    offerRule,
    minCartValueForDiscount,
    couponPrefix,
    couponValidityHours,
    freeShippingEnabled,
    followupEmailEnabled,
    followupSmsEnabled,
  });

  return new Response(null, { status: 303, headers: { Location: "/app/settings?saved=1" } });
};

/* =========================
   UI
   ========================= */
export default function Settings() {
  const { shop, settings } = useLoaderData<typeof loader>();
  const saved = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("saved") === "1" : false;

  const card: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 16,
    background: "white",
    padding: 14,
    boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
  };

  const label: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 1000,
    color: "rgba(17,24,39,0.55)",
    marginBottom: 6,
  };

  const input: React.CSSProperties = {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    padding: "10px 12px",
    fontWeight: 900,
    outline: "none",
  };

  const select: React.CSSProperties = input;

  return (
    <div style={{ padding: 16, maxWidth: 980 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 1100, fontSize: 18, color: "rgba(17,24,39,0.92)" }}>Settings</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span
            style={{
              display: "inline-flex",
              padding: "3px 10px",
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "rgba(0,0,0,0.04)",
              fontWeight: 950,
              fontSize: 12,
            }}
          >
            {shop}
          </span>
          <span style={{ fontSize: 12, fontWeight: 900, color: "rgba(17,24,39,0.45)" }}>
            Vapi Assistant ID + Phone Number ID are global (ENV), not per user.
          </span>
          {saved ? (
            <span
              style={{
                display: "inline-flex",
                padding: "3px 10px",
                borderRadius: 999,
                border: "1px solid rgba(16,185,129,0.25)",
                background: "rgba(16,185,129,0.10)",
                color: "#065f46",
                fontWeight: 950,
                fontSize: 12,
              }}
            >
              Saved
            </span>
          ) : null}
        </div>
      </div>

      <Form method="post" style={{ marginTop: 12, display: "grid", gap: 12 }}>
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 1050 }}>Enable calling</div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 950 }}>
              <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
              Enabled
            </label>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div style={card}>
            <div style={label}>Delay minutes</div>
            <input style={input} name="delayMinutes" defaultValue={settings.delayMinutes} />
          </div>
          <div style={card}>
            <div style={label}>Max attempts</div>
            <input style={input} name="maxAttempts" defaultValue={settings.maxAttempts} />
          </div>
          <div style={card}>
            <div style={label}>Retry minutes</div>
            <input style={input} name="retryMinutes" defaultValue={settings.retryMinutes} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div style={card}>
            <div style={label}>Min order value</div>
            <input style={input} name="minOrderValue" defaultValue={settings.minOrderValue} />
          </div>
          <div style={card}>
            <div style={label}>Currency</div>
            <select style={select} name="currency" defaultValue={pickCurrency(settings.currency)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
          </div>
          <div style={card}>
            <div style={label}>Call window</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input style={input} name="callWindowStart" defaultValue={settings.callWindowStart} />
              <input style={input} name="callWindowEnd" defaultValue={settings.callWindowEnd} />
            </div>
          </div>
        </div>

        <div style={card}>
          <div style={{ fontWeight: 1050, marginBottom: 10 }}>Agent playbook</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={label}>Goal</div>
              <select style={select} name="goal" defaultValue={settings.goal}>
                <option value="complete_checkout">Complete checkout</option>
                <option value="qualify_and_follow_up">Qualify + follow-up</option>
                <option value="support_only">Support only</option>
              </select>
            </div>

            <div>
              <div style={label}>Tone</div>
              <select style={select} name="tone" defaultValue={settings.tone}>
                <option value="neutral">Neutral</option>
                <option value="friendly">Friendly</option>
                <option value="premium">Premium</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>

            <div>
              <div style={label}>Max call length (seconds)</div>
              <input style={input} name="maxCallSeconds" type="number" defaultValue={settings.maxCallSeconds} />
            </div>

            <div>
              <div style={label}>Max follow-up questions</div>
              <input style={input} name="maxFollowupQuestions" type="number" defaultValue={settings.maxFollowupQuestions} />
            </div>
          </div>
        </div>

        <div style={card}>
          <div style={{ fontWeight: 1050, marginBottom: 10 }}>Discount policy</div>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 950, marginBottom: 10 }}>
            <input name="discountEnabled" type="checkbox" defaultChecked={settings.discountEnabled} />
            Enable discounts
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={label}>Max discount %</div>
              <input style={input} name="maxDiscountPercent" type="number" defaultValue={settings.maxDiscountPercent} />
            </div>

            <div>
              <div style={label}>When to offer</div>
              <select style={select} name="offerRule" defaultValue={settings.offerRule}>
                <option value="ask_only">Only if customer asks</option>
                <option value="price_objection">If price objection</option>
                <option value="after_first_objection">After first objection</option>
                <option value="always">Offer proactively</option>
              </select>
            </div>

            <div>
              <div style={label}>Min cart value to allow discount (optional)</div>
              <input
                style={input}
                name="minCartValueForDiscount"
                type="number"
                step="0.01"
                defaultValue={settings.minCartValueForDiscount ?? ""}
                placeholder="e.g. 50"
              />
            </div>

            <div>
              <div style={label}>Coupon validity (hours)</div>
              <input style={input} name="couponValidityHours" type="number" defaultValue={settings.couponValidityHours} />
            </div>

            <div>
              <div style={label}>Coupon prefix (optional)</div>
              <input style={input} name="couponPrefix" type="text" defaultValue={settings.couponPrefix ?? ""} placeholder="e.g. C" />
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 950 }}>
              <input name="freeShippingEnabled" type="checkbox" defaultChecked={settings.freeShippingEnabled} />
              Allow free shipping as alternative offer
            </label>
          </div>
        </div>

        <div style={card}>
          <div style={{ fontWeight: 1050, marginBottom: 10 }}>Follow-ups</div>

          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 950 }}>
              <input name="followupEmailEnabled" type="checkbox" defaultChecked={settings.followupEmailEnabled} />
              Allow follow-up email suggestion
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 950 }}>
              <input name="followupSmsEnabled" type="checkbox" defaultChecked={settings.followupSmsEnabled} />
              Allow follow-up SMS suggestion
            </label>
          </div>
        </div>

        <div style={card}>
          <div style={label}>Custom merchant prompt (injected into every call)</div>
          <textarea
            name="userPrompt"
            defaultValue={settings.userPrompt ?? ""}
            rows={10}
            style={{
              width: "100%",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              padding: "10px 12px",
              fontWeight: 900,
              outline: "none",
              resize: "vertical",
              lineHeight: 1.35,
            }}
            placeholder="Example: Always introduce store name, language rules, objection handling, what to never say..."
          />
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="submit"
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(59,130,246,0.30)",
              background: "rgba(59,130,246,0.10)",
              cursor: "pointer",
              fontWeight: 1000,
            }}
          >
            Save
          </button>
        </div>
      </Form>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
