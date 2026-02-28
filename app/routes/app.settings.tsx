// app/routes/app.settings.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  InlineStack,
  BlockStack,
  Banner,
  Text,
  Button,
  Divider,
} from "@shopify/polaris";

/* =========================
   Types
   ========================= */
type Tone = "neutral" | "friendly" | "premium" | "urgent";
type Goal = "complete_checkout" | "qualify_and_follow_up" | "support_only";
type OfferRule = "ask_only" | "price_objection" | "after_first_objection" | "always";
type PromptMode = "append" | "replace";

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

  sms_template_offer: string | null;
  sms_template_no_offer: string | null;

  // NEW: per-shop sender for Brevo SMS
  brevoSmsSender: string | null;
};

type LoaderData = {
  shop: string;
  saved: boolean;
  settings: {
    enabled: boolean;
    delayMinutes: number;
    maxAttempts: number;
    retryMinutes: number;
    minOrderValue: number;
    currency: string;
    callWindowStart: string;
    callWindowEnd: string;

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

    promptMode: PromptMode;
    userPrompt: string;

    smsTemplateOffer: string;
    smsTemplateNoOffer: string;

    // NEW
    brevoSmsSender: string;
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
  if (s === "price_objection" || s === "after_first_objection" || s === "always" || s === "ask_only")
    return s as OfferRule;
  return "ask_only";
}
function pickCurrency(v: any): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "USD" || s === "EUR" || s === "GBP") return s;
  return "USD";
}
function pickPromptMode(v: any): PromptMode {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "replace" || s === "append") return s as PromptMode;
  return "append";
}

/**
 * NEW: normalize per-shop Brevo sender input
 * - numeric: keep digits only, max 15
 * - alphanumeric: keep A-Z0-9 only, max 11
 */
function normalizeBrevoSenderInput(v: any): string | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;

  const noSpace = raw.replace(/\s+/g, "");
  if (!noSpace) return null;

  // numeric sender (allow + but store without +)
  if (/^\+?\d+$/.test(noSpace)) {
    const digits = noSpace.replace(/^\+/, "").slice(0, 15);
    return digits ? digits : null;
  }

  // alphanumeric sender
  const alpha = noSpace.replace(/[^A-Za-z0-9]/g, "").slice(0, 11);
  return alpha ? alpha : null;
}

/**
 * FIX: merge Shopify embedded params with target params so redirect stays embedded.
 */
function withSearchMerged(path: string, request: Request) {
  const req = new URL(request.url);
  const target = new URL(path, req.origin);

  const out = new URL(target.pathname, req.origin);

  req.searchParams.forEach((v, k) => out.searchParams.set(k, v));
  target.searchParams.forEach((v, k) => out.searchParams.set(k, v));

  const qs = out.searchParams.toString();
  return qs ? `${out.pathname}?${qs}` : out.pathname;
}

async function readSettingsExtras(shop: string): Promise<ExtrasRow | null> {
  // Backward-safe: if column doesn't exist yet, fall back.
  try {
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
        followup_sms_enabled,
        sms_template_offer,
        sms_template_no_offer,
        "brevoSmsSender"
      from public."Settings"
      where shop = ${shop}
      limit 1
    `;
    return rows?.[0] ?? null;
  } catch {
    const rows = await (db as any).$queryRaw<any[]>`
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
        followup_sms_enabled,
        sms_template_offer,
        sms_template_no_offer
      from public."Settings"
      where shop = ${shop}
      limit 1
    `;
    const r = rows?.[0] ?? null;
    if (!r) return null;
    return { ...r, brevoSmsSender: null } as ExtrasRow;
  }
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

    smsTemplateOffer: string | null;
    smsTemplateNoOffer: string | null;

    // NEW
    brevoSmsSender: string | null;
  }
) {
  // Backward-safe: if column doesn't exist yet, update without it.
  try {
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
        followup_sms_enabled = ${data.followupSmsEnabled},
        sms_template_offer = ${data.smsTemplateOffer},
        sms_template_no_offer = ${data.smsTemplateNoOffer},
        "brevoSmsSender" = ${data.brevoSmsSender}
      where shop = ${shop}
    `;
  } catch {
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
        followup_sms_enabled = ${data.followupSmsEnabled},
        sms_template_offer = ${data.smsTemplateOffer},
        sms_template_no_offer = ${data.smsTemplateNoOffer}
      where shop = ${shop}
    `;
  }
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

  const url = new URL(request.url);
  const saved = url.searchParams.get("saved") === "1";

  const defaultOfferTemplate =
    "Finish your checkout: {{discount_link}}\nOffer: {{percent}}% off\nCode: {{offer_code}}\nValid: {{validity_hours}}h";
  const defaultNoOfferTemplate = "Finish your checkout: {{checkout_link}}";

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
    minCartValueForDiscount:
      extras?.min_cart_value_for_discount == null ? null : Number(extras.min_cart_value_for_discount),
    couponPrefix: String(extras?.coupon_prefix ?? "").trim() ? String(extras?.coupon_prefix).trim() : null,
    couponValidityHours: clamp(Number(extras?.coupon_validity_hours ?? 24), 1, 168),
    freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),

    followupEmailEnabled: Boolean(extras?.followup_email_enabled ?? true),
    followupSmsEnabled: Boolean(extras?.followup_sms_enabled ?? false),

    promptMode: pickPromptMode((base as any).promptMode ?? "append"),
    userPrompt: String((base as any).userPrompt ?? ""),

    smsTemplateOffer: String(extras?.sms_template_offer ?? "").trim()
      ? String(extras?.sms_template_offer)
      : defaultOfferTemplate,
    smsTemplateNoOffer: String(extras?.sms_template_no_offer ?? "").trim()
      ? String(extras?.sms_template_no_offer)
      : defaultNoOfferTemplate,

    brevoSmsSender: String(extras?.brevoSmsSender ?? "").trim(),
  };

  return { shop, saved, settings } satisfies LoaderData;
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
  const maxDiscountPercent = clamp(toInt(fd.get("maxDiscountPercent"), Number(extras?.max_discount_percent ?? 10)), 0, 50);
  const offerRule = pickOfferRule(fd.get("offerRule") ?? extras?.offer_rule ?? "ask_only");
  const minCartValueForDiscount = toFloatOrNull(fd.get("minCartValueForDiscount"));
  const couponPrefixRaw = String(fd.get("couponPrefix") ?? "").trim();
  const couponPrefix = couponPrefixRaw ? couponPrefixRaw.slice(0, 12) : null;
  const couponValidityHours = clamp(toInt(fd.get("couponValidityHours"), Number(extras?.coupon_validity_hours ?? 24)), 1, 168);
  const freeShippingEnabled = toBool(fd.get("freeShippingEnabled"));

  const followupEmailEnabled = toBool(fd.get("followupEmailEnabled"));
  const followupSmsEnabled = toBool(fd.get("followupSmsEnabled"));

  const promptMode = pickPromptMode(fd.get("promptMode") ?? (base as any).promptMode ?? "append");
  const userPrompt = String(fd.get("userPrompt") ?? "").trim();

  const smsTemplateOfferRaw = String(fd.get("smsTemplateOffer") ?? "").trim();
  const smsTemplateNoOfferRaw = String(fd.get("smsTemplateNoOffer") ?? "").trim();
  const smsTemplateOffer = smsTemplateOfferRaw ? smsTemplateOfferRaw : null;
  const smsTemplateNoOffer = smsTemplateNoOfferRaw ? smsTemplateNoOfferRaw : null;

  const brevoSmsSender = normalizeBrevoSenderInput(fd.get("brevoSmsSender"));

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
      promptMode,
      userPrompt,
      vapiAssistantId: null,
      vapiPhoneNumberId: null,
    } as any,
  });

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
    smsTemplateOffer,
    smsTemplateNoOffer,
    brevoSmsSender,
  });

  return new Response(null, {
    status: 303,
    headers: { Location: withSearchMerged("/app/settings?saved=1", request) },
  });
};

/* =========================
   UI (Polaris)
   ========================= */
export default function Settings() {
  const { shop, saved, settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [enabled, setEnabled] = React.useState(settings.enabled);
  const [delayMinutes, setDelayMinutes] = React.useState(String(settings.delayMinutes));
  const [maxAttempts, setMaxAttempts] = React.useState(String(settings.maxAttempts));
  const [retryMinutes, setRetryMinutes] = React.useState(String(settings.retryMinutes));
  const [minOrderValue, setMinOrderValue] = React.useState(String(settings.minOrderValue));
  const [currency, setCurrency] = React.useState(pickCurrency(settings.currency));
  const [callWindowStart, setCallWindowStart] = React.useState(settings.callWindowStart);
  const [callWindowEnd, setCallWindowEnd] = React.useState(settings.callWindowEnd);

  const [goal, setGoal] = React.useState<Goal>(settings.goal);
  const [tone, setTone] = React.useState<Tone>(settings.tone);
  const [maxCallSeconds, setMaxCallSeconds] = React.useState(String(settings.maxCallSeconds));
  const [maxFollowupQuestions, setMaxFollowupQuestions] = React.useState(String(settings.maxFollowupQuestions));

  const [discountEnabled, setDiscountEnabled] = React.useState(settings.discountEnabled);
  const [maxDiscountPercent, setMaxDiscountPercent] = React.useState(String(settings.maxDiscountPercent));
  const [offerRule, setOfferRule] = React.useState<OfferRule>(settings.offerRule);
  const [minCartValueForDiscount, setMinCartValueForDiscount] = React.useState(
    settings.minCartValueForDiscount == null ? "" : String(settings.minCartValueForDiscount)
  );
  const [couponPrefix, setCouponPrefix] = React.useState(settings.couponPrefix ?? "");
  const [couponValidityHours, setCouponValidityHours] = React.useState(String(settings.couponValidityHours));
  const [freeShippingEnabled, setFreeShippingEnabled] = React.useState(settings.freeShippingEnabled);

  const [followupEmailEnabled, setFollowupEmailEnabled] = React.useState(settings.followupEmailEnabled);
  const [followupSmsEnabled, setFollowupSmsEnabled] = React.useState(settings.followupSmsEnabled);

  const [promptMode, setPromptMode] = React.useState<PromptMode>(settings.promptMode);
  const [userPrompt, setUserPrompt] = React.useState(settings.userPrompt ?? "");

  const [smsTemplateOffer, setSmsTemplateOffer] = React.useState(settings.smsTemplateOffer ?? "");
  const [smsTemplateNoOffer, setSmsTemplateNoOffer] = React.useState(settings.smsTemplateNoOffer ?? "");

  const [brevoSmsSender, setBrevoSmsSender] = React.useState(settings.brevoSmsSender ?? "");

  const isSaving = fetcher.state === "submitting" || fetcher.state === "loading";

  const goalOptions = [
    { label: "Complete checkout", value: "complete_checkout" },
    { label: "Qualify + follow-up", value: "qualify_and_follow_up" },
    { label: "Support only", value: "support_only" },
  ];
  const toneOptions = [
    { label: "Neutral", value: "neutral" },
    { label: "Friendly", value: "friendly" },
    { label: "Premium", value: "premium" },
    { label: "Urgent", value: "urgent" },
  ];
  const currencyOptions = [
    { label: "USD", value: "USD" },
    { label: "EUR", value: "EUR" },
    { label: "GBP", value: "GBP" },
  ];
  const offerOptions = [
    { label: "Only if customer asks", value: "ask_only" },
    { label: "If price objection", value: "price_objection" },
    { label: "After first objection", value: "after_first_objection" },
    { label: "Offer proactively", value: "always" },
  ];
  const promptModeOptions = [
    { label: "Use default prompt + my prompt", value: "append" },
    { label: "Use only my prompt (advanced)", value: "replace" },
  ];

  const smsVarsHelp =
    "Available variables: {{shop}}, {{shop_name}}, {{customer_name}}, {{checkout_id}}, {{checkout_link}}, {{discount_link}}, {{offer_code}}, {{percent}}, {{validity_hours}}";

  return (
    <Page
      title="Settings"
      subtitle={shop}
      primaryAction={{
        content: isSaving ? "Saving…" : "Save",
        onAction: () => {
          const form = document.getElementById("settings-form") as HTMLFormElement | null;
          form?.requestSubmit?.();
        },
        loading: isSaving,
      }}
    >
      <Layout>
        <Layout.Section>
          {saved ? <Banner tone="success" title="Saved" /> : null}

          <fetcher.Form method="post" id="settings-form">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      Enable calling
                    </Text>
                    <Checkbox label="Enabled" checked={enabled} onChange={setEnabled} />
                  </InlineStack>
                  <input type="hidden" name="enabled" value={enabled ? "on" : ""} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Automation rules
                  </Text>

                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="Delay minutes"
                        name="delayMinutes"
                        value={delayMinutes}
                        onChange={setDelayMinutes}
                        autoComplete="off"
                      />
                      <TextField
                        label="Max attempts"
                        name="maxAttempts"
                        value={maxAttempts}
                        onChange={setMaxAttempts}
                        autoComplete="off"
                      />
                      <TextField
                        label="Retry minutes"
                        name="retryMinutes"
                        value={retryMinutes}
                        onChange={setRetryMinutes}
                        autoComplete="off"
                      />
                    </FormLayout.Group>

                    <FormLayout.Group>
                      <TextField
                        label="Min order value"
                        name="minOrderValue"
                        value={minOrderValue}
                        onChange={setMinOrderValue}
                        autoComplete="off"
                      />
                      <Select label="Currency" name="currency" options={currencyOptions} value={currency} onChange={setCurrency} />
                    </FormLayout.Group>

                    <FormLayout.Group>
                      <TextField
                        label="Call window start (HH:MM)"
                        name="callWindowStart"
                        value={callWindowStart}
                        onChange={setCallWindowStart}
                        autoComplete="off"
                      />
                      <TextField
                        label="Call window end (HH:MM)"
                        name="callWindowEnd"
                        value={callWindowEnd}
                        onChange={setCallWindowEnd}
                        autoComplete="off"
                      />
                    </FormLayout.Group>
                  </FormLayout>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Agent playbook
                  </Text>

                  <FormLayout>
                    <FormLayout.Group>
                      <Select
                        label="Goal"
                        name="goal"
                        options={goalOptions}
                        value={goal}
                        onChange={(v) => setGoal(v as Goal)}
                      />
                      <Select
                        label="Tone"
                        name="tone"
                        options={toneOptions}
                        value={tone}
                        onChange={(v) => setTone(v as Tone)}
                      />
                    </FormLayout.Group>

                    <FormLayout.Group>
                      <TextField
                        label="Max call length (seconds)"
                        name="maxCallSeconds"
                        type="number"
                        value={maxCallSeconds}
                        onChange={setMaxCallSeconds}
                        autoComplete="off"
                      />
                      <TextField
                        label="Max follow-up questions"
                        name="maxFollowupQuestions"
                        type="number"
                        value={maxFollowupQuestions}
                        onChange={setMaxFollowupQuestions}
                        autoComplete="off"
                      />
                    </FormLayout.Group>
                  </FormLayout>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      Discount policy
                    </Text>
                    <Checkbox label="Enable discounts" checked={discountEnabled} onChange={setDiscountEnabled} />
                  </InlineStack>

                  <input type="hidden" name="discountEnabled" value={discountEnabled ? "on" : ""} />

                  <Divider />

                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="Max discount %"
                        name="maxDiscountPercent"
                        type="number"
                        value={maxDiscountPercent}
                        onChange={setMaxDiscountPercent}
                        disabled={!discountEnabled}
                        autoComplete="off"
                      />
                      <Select
                        label="When to offer"
                        name="offerRule"
                        options={offerOptions}
                        value={offerRule}
                        onChange={(v) => setOfferRule(v as OfferRule)}
                        disabled={!discountEnabled}
                      />
                    </FormLayout.Group>

                    <FormLayout.Group>
                      <TextField
                        label="Min cart value to allow discount (optional)"
                        name="minCartValueForDiscount"
                        type="number"
                        value={minCartValueForDiscount}
                        onChange={setMinCartValueForDiscount}
                        disabled={!discountEnabled}
                        autoComplete="off"
                      />
                      <TextField
                        label="Coupon validity (hours)"
                        name="couponValidityHours"
                        type="number"
                        value={couponValidityHours}
                        onChange={setCouponValidityHours}
                        disabled={!discountEnabled}
                        autoComplete="off"
                      />
                    </FormLayout.Group>

                    <FormLayout.Group>
                      <TextField
                        label="Coupon prefix (optional)"
                        name="couponPrefix"
                        value={couponPrefix}
                        onChange={setCouponPrefix}
                        disabled={!discountEnabled}
                        autoComplete="off"
                      />
                      <Checkbox
                        label="Allow free shipping alternative"
                        checked={freeShippingEnabled}
                        onChange={setFreeShippingEnabled}
                        disabled={!discountEnabled}
                      />
                      <input type="hidden" name="freeShippingEnabled" value={freeShippingEnabled ? "on" : ""} />
                    </FormLayout.Group>
                  </FormLayout>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Follow-ups
                  </Text>

                  <InlineStack gap="600">
                    <Checkbox
                      label="Allow follow-up email suggestion"
                      checked={followupEmailEnabled}
                      onChange={setFollowupEmailEnabled}
                    />
                    <Checkbox
                      label="Allow follow-up SMS suggestion"
                      checked={followupSmsEnabled}
                      onChange={setFollowupSmsEnabled}
                    />
                  </InlineStack>

                  <input type="hidden" name="followupEmailEnabled" value={followupEmailEnabled ? "on" : ""} />
                  <input type="hidden" name="followupSmsEnabled" value={followupSmsEnabled ? "on" : ""} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Brevo SMS sender (per shop)
                  </Text>

                  <FormLayout>
                    <TextField
                      label="Sender"
                      name="brevoSmsSender"
                      value={brevoSmsSender}
                      onChange={setBrevoSmsSender}
                      autoComplete="off"
                      helpText="Alphanumeric up to 11 chars (A-Z,0-9) or numeric up to 15 digits. Spaces/symbols are removed."
                      disabled={!followupSmsEnabled}
                    />
                  </FormLayout>

                  <Text as="p" variant="bodySm" tone="subdued">
                    If empty, the server falls back to ENV sender (if configured).
                  </Text>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    SMS message templates
                  </Text>

                  <Text as="p" variant="bodySm" tone="subdued">
                    {smsVarsHelp}
                  </Text>

                  <FormLayout>
                    <TextField
                      label="SMS template (with offer code)"
                      name="smsTemplateOffer"
                      value={smsTemplateOffer}
                      onChange={setSmsTemplateOffer}
                      multiline={6}
                      autoComplete="off"
                      helpText="Used when an offer code exists. Use {{discount_link}} so the discount applies automatically."
                    />

                    <TextField
                      label="SMS template (no offer)"
                      name="smsTemplateNoOffer"
                      value={smsTemplateNoOffer}
                      onChange={setSmsTemplateNoOffer}
                      multiline={4}
                      autoComplete="off"
                      helpText="Used when no offer code exists. Use {{checkout_link}}."
                    />
                  </FormLayout>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Custom merchant prompt
                  </Text>

                  <FormLayout>
                    <FormLayout.Group>
                      <Select
                        label="Prompt mode"
                        name="promptMode"
                        options={promptModeOptions}
                        value={promptMode}
                        onChange={(v) => setPromptMode(v as PromptMode)}
                      />
                    </FormLayout.Group>

                    <TextField
                      label="Injected into every call"
                      name="userPrompt"
                      value={userPrompt}
                      onChange={setUserPrompt}
                      multiline={10}
                      autoComplete="off"
                      helpText="Rules, disclaimers, language, objection handling, store-specific constraints."
                    />
                  </FormLayout>
                </BlockStack>
              </Card>

              <div style={{ display: "none" }}>
                <Button submit>Save</Button>
              </div>
            </BlockStack>
          </fetcher.Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);