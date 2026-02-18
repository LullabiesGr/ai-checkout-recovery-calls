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
function withRequestSearch(path: string, request: Request) {
  const u = new URL(request.url);
  if (!u.search) return path;
  if (path.includes("?")) return path;
  return `${path}${u.search}`;
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

  const url = new URL(request.url);
  const saved = url.searchParams.get("saved") === "1";

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
  const maxFollowupQuestions = clamp(toInt(fd.get("maxFollowupQuestions"), Number(extras?.max_followup_questions ?? 1)), 0, 3);

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

  const userPrompt = String(fd.get("userPrompt") ?? "").trim();

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
  });

  return new Response(null, { status: 303, headers: { Location: withRequestSearch("/app/settings?saved=1", request) } });
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

  const [userPrompt, setUserPrompt] = React.useState(settings.userPrompt ?? "");

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
          {saved ? (
            <Banner tone="success" title="Saved" />
          ) : null}

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
                      <Select label="Goal" name="goal" options={goalOptions} value={goal} onChange={(v) => setGoal(v as Goal)} />
                      <Select label="Tone" name="tone" options={toneOptions} value={tone} onChange={(v) => setTone(v as Tone)} />
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
                    <Checkbox label="Allow follow-up email suggestion" checked={followupEmailEnabled} onChange={setFollowupEmailEnabled} />
                    <Checkbox label="Allow follow-up SMS suggestion" checked={followupSmsEnabled} onChange={setFollowupSmsEnabled} />
                  </InlineStack>

                  <input type="hidden" name="followupEmailEnabled" value={followupEmailEnabled ? "on" : ""} />
                  <input type="hidden" name="followupSmsEnabled" value={followupSmsEnabled ? "on" : ""} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Custom merchant prompt
                  </Text>

                  <TextField
                    label="Injected into every call"
                    name="userPrompt"
                    value={userPrompt}
                    onChange={setUserPrompt}
                    multiline={10}
                    autoComplete="off"
                    helpText="Rules, disclaimers, language, objection handling, store-specific constraints."
                  />
                </BlockStack>
              </Card>

              {/* fallback submit button for browsers without Page primaryAction submit */}
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
