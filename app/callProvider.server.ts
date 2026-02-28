import db from "./db.server";
import { randomBytes } from "node:crypto";
import { sessionStorage } from "./shopify.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

type Tone = "neutral" | "friendly" | "premium" | "urgent";
type Goal = "complete_checkout" | "qualify_and_follow_up" | "support_only";
type OfferRule = "ask_only" | "price_objection" | "after_first_objection" | "always";

type PromptMode = "append" | "replace" | "default_only";
function pickPromptMode(v: any): PromptMode {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "replace" || s === "default_only" || s === "append") return s as PromptMode;
  return "replace";
}

type ExtrasRow = {
  tone: string | null;
  goal: string | null;
  max_call_seconds: number | null;
  max_followup_questions: number | null;

  // per-shop Brevo sender
  brevoSmsSender: string | null;

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

  vapi_assistant_id: string | null;
  vapi_phone_number_id: string | null;
};

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
  if (s === "price_objection" || s === "after_first_objection" || s === "always" || s === "ask_only") {
    return s as OfferRule;
  }
  return "ask_only";
}

async function readSettingsExtras(shop: string): Promise<ExtrasRow | null> {
  const row: any = await db.settings.findUnique({ where: { shop } });
  if (!row) return null;

  const pick = (a: any, b: any) => (a !== undefined && a !== null ? a : b);

  return {
    tone: pick(row.tone, row.tone) ?? null,
    goal: pick(row.goal, row.goal) ?? null,
    max_call_seconds: pick(row.max_call_seconds, row.maxCallSeconds) ?? null,
    max_followup_questions: pick(row.max_followup_questions, row.maxFollowupQuestions) ?? null,

    discount_enabled: pick(row.discount_enabled, row.discountEnabled) ?? null,
    max_discount_percent: pick(row.max_discount_percent, row.maxDiscountPercent) ?? null,
    offer_rule: pick(row.offer_rule, row.offerRule) ?? null,
    min_cart_value_for_discount: pick(row.min_cart_value_for_discount, row.minCartValueForDiscount) ?? null,
    coupon_prefix: pick(row.coupon_prefix, row.couponPrefix) ?? null,
    coupon_validity_hours: pick(row.coupon_validity_hours, row.couponValidityHours) ?? null,
    free_shipping_enabled: pick(row.free_shipping_enabled, row.freeShippingEnabled) ?? null,

    followup_email_enabled: pick(row.followup_email_enabled, row.followupEmailEnabled) ?? null,
    followup_sms_enabled: pick(row.followup_sms_enabled, row.followupSmsEnabled) ?? null,

    sms_template_offer: pick(row.sms_template_offer, row.smsTemplateOffer) ?? null,
    sms_template_no_offer: pick(row.sms_template_no_offer, row.smsTemplateNoOffer) ?? null,

    vapi_assistant_id: pick(row.vapi_assistant_id, row.vapiAssistantId) ?? null,
    vapi_phone_number_id: pick(row.vapi_phone_number_id, row.vapiPhoneNumberId) ?? null,

    brevoSmsSender: pick(row.brevoSmsSender, row.brevo_sms_sender) ?? null,
  };
}

function toneGuidance(tone: Tone) {
  if (tone === "friendly") return "Warm, helpful, human. Short sentences. Natural pacing.";
  if (tone === "premium") return "Calm, confident, concierge-style. Precise language. No slang.";
  if (tone === "urgent") return "Direct and efficient. Time-boxed. Clear next step. No rambling.";
  return "Neutral, professional, helpful.";
}

function goalGuidance(goal: Goal) {
  if (goal === "qualify_and_follow_up") {
    return "Goal: qualify intent fast, then secure permission for follow-up if they will not complete now.";
  }
  if (goal === "support_only") {
    return "Goal: support only. Do not offer discounts proactively unless asked.";
  }
  return "Goal: complete checkout on this call if possible.";
}

function offerGuidance(args: {
  discountEnabled: boolean;
  maxDiscountPercent: number;
  offerRule: OfferRule;
  minCartValueForDiscount: number | null;
  couponPrefix: string | null;
  couponValidityHours: number;
  freeShippingEnabled: boolean;
}) {
  if (!args.discountEnabled && !args.freeShippingEnabled) return "Offers: no discounts and no free shipping offers allowed.";

  const minCart =
    args.minCartValueForDiscount == null
      ? "No minimum cart value."
      : `Only allow offers if cart total >= ${args.minCartValueForDiscount}.`;

  const when =
    args.offerRule === "always"
      ? "Offer can be proactively mentioned once."
      : args.offerRule === "after_first_objection"
        ? "Offer only after the first objection."
        : args.offerRule === "price_objection"
          ? "Offer only if the objection is price/cost."
          : "Offer only if the customer explicitly asks for a discount/coupon.";

  const discount = args.discountEnabled
    ? `Discount: allowed up to ${args.maxDiscountPercent}% max. Do NOT exceed. Coupon prefix: ${
        args.couponPrefix ? args.couponPrefix : "none"
      }. Coupon validity: ${args.couponValidityHours} hours.`
    : "Discount: disabled.";

  const ship = args.freeShippingEnabled
    ? "Free shipping: allowed as alternative offer."
    : "Free shipping: not allowed.";

  return `Offers policy:
- ${when}
- ${minCart}
- ${discount}
- ${ship}`;
}

function followupGuidance(args: {
  followupEmailEnabled: boolean;
  followupSmsEnabled: boolean;
  maxFollowupQuestions: number;
}) {
  const channels: string[] = [];
  if (args.followupEmailEnabled) channels.push("email");
  if (args.followupSmsEnabled) channels.push("sms");
  const ch = channels.length ? channels.join(" + ") : "none";

  return `Follow-up:
- Allowed channels: ${ch}.
- Ask at most ${args.maxFollowupQuestions} follow-up questions total.
- If they decline, stop asking and end politely.`;
}

/* =========================
   Follow-up memory helpers
   ========================= */

type PrevSummaryRow = {
  received_at: string | null;
  answered: boolean | null;
  voicemail: boolean | null;
  sentiment: string | null;
  call_outcome: string | null;
};

function trunc(s: any, max: number) {
  const x = String(s ?? "");
  if (x.length <= max) return x;
  return x.slice(0, Math.max(0, max - 1)) + "…";
}

function cleanLine(s: any) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   JSON helper
   ========================= */
function safeJsonParse(s: any): any | null {
  try {
    if (!s) return null;
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}

function readAnalysisJsonObject(raw: string | null | undefined): Record<string, any> {
  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {};
}

function firstNameOnly(name: string | null | undefined) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts[0] ?? null;
}

const RECENT_TOOL_RESULT_TTL_MS = 10 * 60 * 1000;
const recentOfferToolResults = new Map<string, { at: number; result: string }>();

function makeToolResultCacheKey(shop: string, callJobId: string, toolCallId: string) {
  return `${shop}:${callJobId}:${toolCallId}`;
}

function getRecentToolResult(key: string): string | null {
  const hit = recentOfferToolResults.get(key);
  if (!hit) return null;

  if (Date.now() - hit.at > RECENT_TOOL_RESULT_TTL_MS) {
    recentOfferToolResults.delete(key);
    return null;
  }

  return hit.result;
}

function setRecentToolResult(key: string, result: string) {
  recentOfferToolResults.set(key, { at: Date.now(), result });

  if (recentOfferToolResults.size > 500) {
    for (const [k, v] of recentOfferToolResults.entries()) {
      if (Date.now() - v.at > RECENT_TOOL_RESULT_TTL_MS) {
        recentOfferToolResults.delete(k);
      }
    }
  }
}

function isRecentIso(iso: any, maxAgeMs: number) {
  const ts = new Date(String(iso ?? "")).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= maxAgeMs;
}

function buildToolSuccessResult(args: {
  messageId: string | null;
  offerType: "link_only" | "discount" | "free_shipping";
  code: string | null;
  discountPercent: number | null;
}) {
  return JSON.stringify({
    ok: true,
    sms_sent: true,
    sms_message_id: args.messageId,
    offer_type: args.offerType,
    code: args.code,
    discount_percent: args.discountPercent,
  });
}

/* =========================
   Country inference (from checkout.raw)
   ========================= */
const ISO2_TO_CALLING_CODE: Record<string, string> = {
  US: "1",
  CA: "1",
  GR: "30",
  GB: "44",
  IE: "353",
  FR: "33",
  DE: "49",
  IT: "39",
  ES: "34",
  PT: "351",
  NL: "31",
  BE: "32",
  LU: "352",
  CH: "41",
  AT: "43",
  SE: "46",
  NO: "47",
  DK: "45",
  FI: "358",
  PL: "48",
  CZ: "420",
  SK: "421",
  HU: "36",
  RO: "40",
  BG: "359",
  HR: "385",
  SI: "386",
  RS: "381",
  BA: "387",
  ME: "382",
  MK: "389",
  AL: "355",
  TR: "90",
  CY: "357",
  MT: "356",
  IS: "354",
  EE: "372",
  LV: "371",
  LT: "370",
  UA: "380",
  MD: "373",
  IL: "972",
  AE: "971",
  SA: "966",
  QA: "974",
  KW: "965",
  BH: "973",
  OM: "968",
  JO: "962",
  LB: "961",
  IQ: "964",
  IR: "98",
  ZA: "27",
  EG: "20",
  MA: "212",
  TN: "216",
  DZ: "213",
  NG: "234",
  KE: "254",
  GH: "233",
  AU: "61",
  NZ: "64",
  JP: "81",
  KR: "82",
  CN: "86",
  IN: "91",
  PK: "92",
  BD: "880",
  SG: "65",
  MY: "60",
  TH: "66",
  VN: "84",
  ID: "62",
  PH: "63",
  HK: "852",
  TW: "886",
  MX: "52",
  BR: "55",
  AR: "54",
  CL: "56",
  CO: "57",
  PE: "51",
};

function inferIso2FromCheckoutRaw(checkoutRaw: string | null): string | null {
  const j = safeJsonParse(checkoutRaw);
  if (!j) return null;

  const candidates = [
    j?.shippingAddress?.countryCodeV2,
    j?.shippingAddress?.countryCode,
    j?.billingAddress?.countryCodeV2,
    j?.billingAddress?.countryCode,
    j?.customer?.defaultAddress?.countryCodeV2,
    j?.customer?.defaultAddress?.countryCode,
  ]
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean);

  if (candidates.length) return candidates[0].toUpperCase();

  const url = String(j?.abandonedCheckoutUrl ?? "").trim();
  if (url) {
    try {
      const u = new URL(url);
      const loc = String(u.searchParams.get("locale") ?? "").trim();
      const m = /([A-Za-z]{2})-([A-Za-z]{2})/.exec(loc);
      if (m) return m[2].toUpperCase();
    } catch {
      // ignore
    }
  }

  return null;
}

function inferCallingCodeFromCheckoutRaw(checkoutRaw: string | null): string | null {
  const iso2 = inferIso2FromCheckoutRaw(checkoutRaw);
  if (!iso2) return null;
  return ISO2_TO_CALLING_CODE[iso2] ?? null;
}

/* =========================
   Phone normalization (E.164)
   ========================= */
function normalizePhoneE164(raw: any, defaultCallingCode?: string | null): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let s = input.replace(/^tel:/i, "").trim();

  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("011")) s = "+" + s.slice(3);

  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }

  if (digits.length >= 8 && digits.length <= 15) {
    if (defaultCallingCode && digits.startsWith(defaultCallingCode)) return "+" + digits;
    if (digits.length >= 11) return "+" + digits;
  }

  if (!defaultCallingCode) return null;

  let national = digits;
  const keepLeadingZeroCallingCodes = new Set(["39"]);
  if (national.startsWith("0") && !keepLeadingZeroCallingCodes.has(defaultCallingCode)) {
    national = national.replace(/^0+/, "");
    if (!national) return null;
  }

  const full = defaultCallingCode + national;
  if (full.length < 8 || full.length > 15) return null;
  return "+" + full;
}

/* =========================
   Previous call memory
   ========================= */
async function readPreviousCallMemory(params: {
  shop: string;
  checkoutId: string;
  currentCallJobId: string;
}): Promise<string | null> {
  const { shop, checkoutId, currentCallJobId } = params;

  try {
    const rows = await (db as any).$queryRaw<PrevSummaryRow[]>`
      select
        received_at,
        answered,
        voicemail,
        sentiment,
        call_outcome
      from public."vapi_call_summaries"
      where shop = ${shop}
        and checkout_id = ${checkoutId}
        and (call_job_id is null or call_job_id <> ${currentCallJobId})
      order by received_at desc nulls last
      limit 1
    `;
    const r = rows?.[0];
    if (r) {
      const outcome = cleanLine(r.call_outcome || "unknown");
      const ans = r.answered == null ? "unknown" : r.answered ? "yes" : "no";
      const vm = r.voicemail == null ? "unknown" : r.voicemail ? "yes" : "no";
      const sent = cleanLine(r.sentiment || "unknown");
      return trunc(`[LAST CALL] outcome=${outcome}; answered=${ans}; voicemail=${vm}; sentiment=${sent}`, 900);
    }
  } catch {
    // ignore
  }

  const prevJob = await db.callJob.findFirst({
    where: {
      shop,
      checkoutId,
      id: { not: currentCallJobId },
      status: { in: ["COMPLETED", "FAILED"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      outcome: true,
      endedReason: true,
      sentiment: true,
      reason: true,
      nextAction: true,
      followUp: true,
      transcript: true,
    },
  });

  if (!prevJob) return null;

  const lines: string[] = [];
  lines.push(
    `[LAST CALL] status=${cleanLine(prevJob.status)}; outcome=${cleanLine(prevJob.outcome)}; sentiment=${cleanLine(
      prevJob.sentiment
    )}; ended_reason=${cleanLine(prevJob.endedReason)}`
  );
  if (prevJob.reason) lines.push(`reason: ${trunc(cleanLine(prevJob.reason), 240)}`);
  if (prevJob.nextAction) lines.push(`next_action: ${trunc(cleanLine(prevJob.nextAction), 240)}`);
  if (prevJob.followUp) lines.push(`follow_up: ${trunc(cleanLine(prevJob.followUp), 240)}`);

  const t = cleanLine(prevJob.transcript || "");
  if (t) lines.push(`transcript_excerpt: ${trunc(t, 700)}`);

  return trunc(lines.join("\n"), 1400);
}

/* =========================
   Offer/SMS helpers
   ========================= */
function mergeAnalysisJson(prev: string | null, patch: any) {
  const base = safeJsonParse(prev) || {};
  return JSON.stringify({ ...base, ...patch });
}

function extractRecoveryUrlFromCheckoutRaw(raw: string | null): string | null {
  const j = safeJsonParse(raw);
  const u = j?.abandonedCheckoutUrl || j?.abandoned_checkout_url || j?.recovery_url || j?.recoveryUrl || null;
  const out = String(u ?? "").trim();
  return out ? out : null;
}

function compactCheckoutUrl(urlStr: string) {
  const raw = String(urlStr ?? "").trim();
  if (!raw) return raw;

  try {
    const u = new URL(raw);
    u.searchParams.delete("locale");
    u.searchParams.delete("discount");
    return u.toString();
  } catch {
    return raw;
  }
}

function normalizePrefix(prefix: string | null) {
  const p = String(prefix ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return p.slice(0, 6) || "C";
}

function fourDigitCodeSuffix() {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return String(n);
}

function makeUniqueCode(args: { prefix?: string | null }) {
  const pfx = normalizePrefix(args.prefix ?? "C");
  return `${pfx}${fourDigitCodeSuffix()}`;
}

function makeUniqueCodeSimple(args: { prefix?: string | null }) {
  const pfx = normalizePrefix(args.prefix ?? "C");
  return `${pfx}${fourDigitCodeSuffix()}`;
}

function isLikelyDuplicateDiscountCodeError(err: any) {
  const s = String(err?.message ?? err ?? "").toLowerCase();
  return s.includes("already") || s.includes("taken") || s.includes("code");
}

function applyTemplate(tpl: string, vars: Record<string, string>) {
  let out = String(tpl ?? "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

function buildSmsText(args: {
  templateOffer?: string | null;
  templateNoOffer?: string | null;
  vars: Record<string, string>;
  hasOffer: boolean;
}) {
  const defaultOfferTemplate = "Checkout: {{checkout_link}} Code: {{offer_code}}";
  const defaultNoOfferTemplate = "Checkout: {{checkout_link}}";

  const tpl = args.hasOffer
    ? String(args.templateOffer ?? "").trim() || defaultOfferTemplate
    : String(args.templateNoOffer ?? "").trim() || defaultNoOfferTemplate;

  const out = applyTemplate(tpl, args.vars)
    .replace(/\s+/g, " ")
    .trim();

  if (out) return out;

  return args.hasOffer
    ? `Checkout: ${args.vars.checkout_link} Code: ${args.vars.offer_code}`.replace(/\s+/g, " ").trim()
    : `Checkout: ${args.vars.checkout_link}`.replace(/\s+/g, " ").trim();
}

/* =========================
   Shopify Discount Creation
   ========================= */
const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION ?? "2025-07";

async function getOfflineAccessToken(shop: string): Promise<string> {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  const offline = sessions.find((s: any) => s && s.isOnline === false);
  const token = String((offline as any)?.accessToken ?? "").trim();
  if (!token) throw new Error(`Missing offline access token for shop=${shop}. Reinstall app to reauthorize scopes.`);
  return token;
}

async function shopifyGraphql(shop: string, accessToken: string, query: string, variables: any) {
  const endpoint = `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Shopify GraphQL non-JSON response HTTP ${res.status}: ${text.slice(0, 800)}`);
  }

  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (Array.isArray(json?.errors) && json.errors.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json;
}

function hoursFromNowIso(hours: number) {
  const h = Math.max(1, Math.min(168, Math.floor(Number(hours) || 24)));
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

async function findCustomerGidByEmail(
  shop: string,
  accessToken: string,
  email: string | null | undefined
): Promise<string | null> {
  const e = String(email ?? "").trim();
  if (!e) return null;

  const query = `
    query CustomerByEmail($q: String!) {
      customers(first: 1, query: $q) {
        nodes { id email }
      }
    }
  `;
  const q = `email:${e}`;
  const out = await shopifyGraphql(shop, accessToken, query, { q });
  const node = out?.data?.customers?.nodes?.[0];
  const id = String(node?.id ?? "").trim();
  return id ? id : null;
}

async function createDiscountCodeBasic(params: {
  shop: string;
  accessToken: string;
  code: string;
  percent: number;
  startsAt: string;
  endsAt: string | null;
  customerGid: string | null;
  minSubtotal: number | null;
}) {
  const mutation = `
    mutation CreateDiscountCode($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const pct = Math.max(1, Math.min(99, Math.floor(Number(params.percent) || 0)));
  const percentage = Math.max(0.01, Math.min(0.99, pct / 100));

  const basicCodeDiscount: any = {
    title: `${pct}% Recovery`,
    code: params.code,
    startsAt: params.startsAt,
    appliesOncePerCustomer: true,
    customerSelection: params.customerGid ? { customers: { add: [params.customerGid] } } : { all: true },
    customerGets: { value: { percentage }, items: { all: true } },
  };

  if (params.endsAt) basicCodeDiscount.endsAt = params.endsAt;

  if (params.minSubtotal != null && Number.isFinite(Number(params.minSubtotal)) && Number(params.minSubtotal) > 0) {
    basicCodeDiscount.minimumRequirement = {
      subtotal: { greaterThanOrEqualToSubtotal: String(params.minSubtotal) },
    };
  }

  const out = await shopifyGraphql(params.shop, params.accessToken, mutation, { basicCodeDiscount });

  const payload = out?.data?.discountCodeBasicCreate;
  if (!payload) throw new Error(`discountCodeBasicCreate returned null payload: ${JSON.stringify(out)}`);

  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => String(e?.message ?? "")).filter(Boolean).join(" | "));

  const nodeId = payload?.codeDiscountNode?.id ?? null;
  const createdCode = payload?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ?? null;

  if (!nodeId) throw new Error(`discountCodeBasicCreate returned no codeDiscountNode: ${JSON.stringify(payload)}`);

  return { nodeId: String(nodeId), createdCode: createdCode ? String(createdCode) : null };
}

async function createDiscountCodeFreeShipping(params: {
  shop: string;
  accessToken: string;
  code: string;
  startsAt: string;
  endsAt: string | null;
  customerGid: string | null;
  minSubtotal: number | null;
}) {
  const mutation = `
    mutation CreateFreeShipping($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
      discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeFreeShipping {
              title
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const freeShippingCodeDiscount: any = {
    title: `Free Shipping Recovery`,
    code: params.code,
    startsAt: params.startsAt,
    appliesOncePerCustomer: true,
    customerSelection: params.customerGid ? { customers: { add: [params.customerGid] } } : { all: true },
    destination: { all: true },
  };

  if (params.endsAt) freeShippingCodeDiscount.endsAt = params.endsAt;

  if (params.minSubtotal != null && Number.isFinite(Number(params.minSubtotal)) && Number(params.minSubtotal) > 0) {
    freeShippingCodeDiscount.minimumRequirement = {
      subtotal: { greaterThanOrEqualToSubtotal: String(params.minSubtotal) },
    };
  }

  const out = await shopifyGraphql(params.shop, params.accessToken, mutation, { freeShippingCodeDiscount });

  const payload = out?.data?.discountCodeFreeShippingCreate;
  if (!payload) throw new Error(`discountCodeFreeShippingCreate returned null payload: ${JSON.stringify(out)}`);

  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => String(e?.message ?? "")).filter(Boolean).join(" | "));

  const nodeId = payload?.codeDiscountNode?.id ?? null;
  const createdCode = payload?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ?? null;

  if (!nodeId) throw new Error(`discountCodeFreeShippingCreate returned no codeDiscountNode: ${JSON.stringify(payload)}`);

  return { nodeId: String(nodeId), createdCode: createdCode ? String(createdCode) : null };
}

/* =========================
   Checkout backfill (if DB missing checkout row)
   ========================= */
function gidCandidatesForAbandonedCheckout(checkoutId: string): string[] {
  const id = String(checkoutId ?? "").trim();
  if (!id) return [];

  if (id.startsWith("gid://")) {
    const candidates = [id];
    candidates.push(id.replace("/Checkout/", "/AbandonedCheckout/"));
    candidates.push(id.replace("/checkout/", "/AbandonedCheckout/"));
    return Array.from(new Set(candidates)).filter(Boolean);
  }

  if (/^\d+$/.test(id)) return [`gid://shopify/AbandonedCheckout/${id}`];

  return [`gid://shopify/AbandonedCheckout/${id}`];
}

async function fetchAbandonedCheckoutByGid(shop: string, accessToken: string, gid: string): Promise<any | null> {
  const query = `
    query Node($id: ID!) {
      node(id: $id) {
        ... on AbandonedCheckout {
          id
          abandonedCheckoutUrl
          email
          phone
          createdAt
          updatedAt
          completedAt
          totalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          shippingAddress { firstName lastName countryCodeV2 country }
          billingAddress { countryCodeV2 country }
          customer { firstName lastName email phone defaultAddress { countryCodeV2 country } }
          lineItems(first: 10) {
            edges { node { title quantity variantTitle originalUnitPriceSet { shopMoney { amount currencyCode } } } }
            nodes { title quantity variantTitle originalUnitPriceSet { shopMoney { amount currencyCode } } }
          }
        }
      }
    }
  `;

  const out = await shopifyGraphql(shop, accessToken, query, { id: gid });
  const node = out?.data?.node ?? null;
  if (node && node.abandonedCheckoutUrl) return node;

  try {
    const q2 = `
      query AbandonedCheckouts($q: String!) {
        abandonedCheckouts(first: 1, query: $q) {
          nodes {
            id
            abandonedCheckoutUrl
            email
            phone
            createdAt
            updatedAt
            completedAt
            totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            shippingAddress { firstName lastName countryCodeV2 country }
            billingAddress { countryCodeV2 country }
            customer { firstName lastName email phone defaultAddress { countryCodeV2 country } }
            lineItems(first: 10) {
              edges { node { title quantity variantTitle originalUnitPriceSet { shopMoney { amount currencyCode } } } }
              nodes { title quantity variantTitle originalUnitPriceSet { shopMoney { amount currencyCode } } }
            }
          }
        }
      }
    `;
    const out2 = await shopifyGraphql(shop, accessToken, q2, { q: `id:${gid}` });
    const n2 = out2?.data?.abandonedCheckouts?.nodes?.[0] ?? null;
    if (n2 && n2.abandonedCheckoutUrl) return n2;
  } catch {
    // ignore
  }

  return null;
}

function mapItemsJsonFromAbandonedCheckout(n: any): string | null {
  const edges = Array.isArray(n?.lineItems?.edges) ? n.lineItems.edges : [];
  const nodes = Array.isArray(n?.lineItems?.nodes) ? n.lineItems.nodes : [];
  const list = (edges.length ? edges.map((e: any) => e?.node) : nodes).filter(Boolean);

  const items = list
    .map((it: any) => ({
      title: it?.title ?? null,
      quantity: Number(it?.quantity ?? 1),
      variantTitle: it?.variantTitle ?? null,
      price: it?.originalUnitPriceSet?.shopMoney?.amount ?? null,
      currency: it?.originalUnitPriceSet?.shopMoney?.currencyCode ?? null,
    }))
    .filter((x: any) => x.title);

  return items.length ? JSON.stringify(items) : null;
}

function mapCustomerNameFromAbandonedCheckout(n: any): string | null {
  const first = String(n?.shippingAddress?.firstName ?? n?.customer?.firstName ?? "").trim();
  const last = String(n?.shippingAddress?.lastName ?? n?.customer?.lastName ?? "").trim();
  const full = `${first} ${last}`.trim();
  return full ? full : null;
}

function mapMoney(n: any): { value: number; currency: string } {
  const m = n?.totalPriceSet?.shopMoney ?? n?.totalPriceSet?.presentmentMoney ?? null;
  const amount = Number(m?.amount ?? 0);
  const currency = String(m?.currencyCode ?? "USD").toUpperCase();
  return { value: Number.isFinite(amount) ? amount : 0, currency: currency || "USD" };
}

async function backfillCheckoutFromShopify(shop: string, checkoutIdKey: string): Promise<boolean> {
  const key = String(checkoutIdKey ?? "").trim();
  if (!shop || !key) return false;

  try {
    const accessToken = await getOfflineAccessToken(shop);
    const candidates = gidCandidatesForAbandonedCheckout(key);

    for (const gid of candidates) {
      try {
        const node = await fetchAbandonedCheckoutByGid(shop, accessToken, gid);
        if (!node) continue;

        const money = mapMoney(node);
        const completedAt = node?.completedAt ? new Date(node.completedAt) : null;

        const abandonedAt =
          completedAt
            ? null
            : node?.updatedAt || node?.createdAt
              ? new Date(String(node.updatedAt ?? node.createdAt))
              : null;

        await db.checkout.upsert({
          where: { shop_checkoutId: { shop, checkoutId: key } },
          create: {
            shop,
            checkoutId: key,
            token: null,
            email: node?.email ?? node?.customer?.email ?? null,
            phone: node?.phone ?? node?.customer?.phone ?? null,
            value: money.value,
            currency: money.currency,
            status: completedAt ? ("CONVERTED" as any) : ("ABANDONED" as any),
            abandonedAt,
            customerName: mapCustomerNameFromAbandonedCheckout(node),
            itemsJson: mapItemsJsonFromAbandonedCheckout(node),
            raw: JSON.stringify({ ...node, _fetchedGid: gid, _fetchedAt: new Date().toISOString() }),
          } as any,
          update: {
            email: node?.email ?? node?.customer?.email ?? null,
            phone: node?.phone ?? node?.customer?.phone ?? null,
            value: money.value,
            currency: money.currency,
            status: completedAt ? ("CONVERTED" as any) : ("ABANDONED" as any),
            abandonedAt,
            customerName: mapCustomerNameFromAbandonedCheckout(node),
            itemsJson: mapItemsJsonFromAbandonedCheckout(node),
            raw: JSON.stringify({ ...node, _fetchedGid: gid, _fetchedAt: new Date().toISOString() }),
          } as any,
        });

        return true;
      } catch {
        // try next candidate
      }
    }
  } catch {
    return false;
  }

  return false;
}

/* =========================
   Prompt builder
   ========================= */
function buildFactsBlock(args: {
  attemptNumber: number;
  previousMemory?: string | null;
  checkout: {
    checkoutId: string;
    customerName?: string | null;
    email?: string | null;
    phone?: string | null;
    value: number;
    currency: string;
    itemsJson?: string | null;
  };
  playbook: {
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
  };
}) {
  const { checkout, playbook } = args;

  const items = (() => {
    try {
      const arr = checkout.itemsJson ? JSON.parse(checkout.itemsJson) : [];
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, 10);
    } catch {
      return [];
    }
  })();

  const cartText =
    items.length === 0
      ? "No cart items available."
      : items.map((it: any) => `- ${it?.title ?? "Item"} x${Number(it?.quantity ?? 1)}`).join("\n");

  const memory = String(args.previousMemory ?? "").trim();

  const lines: string[] = [];
  lines.push(`CALL FACTS`);
  lines.push(`attempt_number: ${Number(args.attemptNumber ?? 1)}`);
  lines.push(`checkout_id: ${checkout.checkoutId}`);
  lines.push(`customer_name: ${checkout.customerName ?? "-"}`);
  lines.push(`email: ${checkout.email ?? "-"}`);
  lines.push(`phone_e164: ${checkout.phone ?? "-"}`);
  lines.push(`cart_total: ${checkout.value} ${checkout.currency}`);
  lines.push(`cart_items:\n${cartText}`);

  lines.push(`\nCONFIGURED SETTINGS`);
  lines.push(`tone: ${playbook.tone}`);
  lines.push(`goal: ${playbook.goal}`);
  lines.push(`max_call_seconds: ${playbook.maxCallSeconds}`);
  lines.push(`max_followup_questions: ${playbook.maxFollowupQuestions}`);
  lines.push(`discount_enabled: ${playbook.discountEnabled}`);
  lines.push(`max_discount_percent: ${playbook.maxDiscountPercent}`);
  lines.push(`offer_rule: ${playbook.offerRule}`);
  lines.push(`min_cart_value_for_discount: ${playbook.minCartValueForDiscount ?? "none"}`);
  lines.push(`coupon_prefix: ${playbook.couponPrefix ?? "none"}`);
  lines.push(`coupon_validity_hours: ${playbook.couponValidityHours}`);
  lines.push(`free_shipping_enabled: ${playbook.freeShippingEnabled}`);
  lines.push(`followup_email_enabled: ${playbook.followupEmailEnabled}`);
  lines.push(`followup_sms_enabled: ${playbook.followupSmsEnabled}`);

  if (memory) {
    lines.push(`\nPREVIOUS CALL MEMORY`);
    lines.push(memory);
  }

  return trunc(lines.join("\n"), 1800);
}

function buildSystemPrompt(args: {
  merchantPrompt?: string | null;
  promptMode?: PromptMode;
  attemptNumber?: number;
  previousMemory?: string | null;
  smsEnabled?: boolean;
  offer?: {
    checkoutLink: string | null;
    offerCode: string | null;
    discountPercent: number | null;
    couponValidityHours: number;
  };
  checkout: {
    checkoutId: string;
    customerName?: string | null;
    email?: string | null;
    phone?: string | null;
    value: number;
    currency: string;
    itemsJson?: string | null;
  };
  playbook: {
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
  };
}) {
  const { merchantPrompt, checkout, playbook } = args;

  const mode = pickPromptMode(args.promptMode ?? "replace");
  const merchant = mode === "default_only" ? "" : String(merchantPrompt ?? "").trim();

  const items = (() => {
    try {
      const arr = checkout.itemsJson ? JSON.parse(checkout.itemsJson) : [];
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, 10);
    } catch {
      return [];
    }
  })();

  const cartText =
    items.length === 0
      ? "No cart items available."
      : items.map((it: any) => `- ${it?.title ?? "Item"} x${Number(it?.quantity ?? 1)}`).join("\n");

  const attemptN = Number(args.attemptNumber ?? 1);
  const memory = (args.previousMemory ?? "").trim();

  const memoryBlock = memory
    ? `
Previous call memory (ground truth, do not contradict):
${memory}

Memory rules:
- Continue from the customer's last intent or objection.
- If memory is unclear, ask one confirmation question max, then proceed.
`.trim()
    : "";

  const offer = args.offer;
  const checkoutLink = offer?.checkoutLink ? offer.checkoutLink : null;
  const offerCode = offer?.offerCode ? offer.offerCode : null;
  const discountPercent = offer?.discountPercent ?? null;
  const validityHours = offer?.couponValidityHours ?? playbook.couponValidityHours;

  const merchantBlock =
    mode === "append" && merchant
      ? `
MERCHANT INSTRUCTIONS (HIGH PRIORITY)
You MUST follow these instructions exactly.
- If they conflict with the "Hard rules" section, follow Hard rules.
- Otherwise, these instructions override tone and playbook defaults.

${merchant}
`.trim()
      : "";

  const smsBlock =
    args.smsEnabled && checkout.phone
      ? `
SMS / OFFER TOOL (tool use):
- Tool name: send_checkout_offer
- Call it exactly ONCE only after the customer accepts the next step.
- Immediately before the tool call, say exactly: "I'll send that by text right now."
- After a successful tool result, say: "I've sent the text. Your code is [code]."
- Say the code aloud clearly, one time, after the tool succeeds.
- Never read CHECKOUT_LINK aloud.
- Never spell domains, query parameters, or URL characters aloud.
- You may choose the final offer during the conversation, but you must stay within the configured limits.
- If you choose a discount, pass the exact discountPercent you decided on. Do not exceed the configured maximum.
- Do not promise that any code was sent until the tool succeeds.
`.trim()
      : "";

  const base = `
You are the merchant's AI phone agent. Your job: recover an abandoned checkout politely and efficiently.
${attemptN > 1 ? `This is a follow-up attempt (#${attemptN}).` : "This is the first attempt."}

Hard rules:
- Confirm identity and ask if it's a good time.
- Keep it short. Target a maximum call length of ~${playbook.maxCallSeconds} seconds.
- Do not be pushy. If not interested, end politely.
- Never invent policies, discounts, coupon codes, or links. Use only what is provided below.
- Never read, spell, or repeat the checkout URL aloud.
- Never spell domains, query strings, or recovery-link characters aloud.
- Do not restate the cart total unless the customer directly asks.
- When a discount is allowed, propose one specific percentage. Do not ask the customer to choose a percentage.
- If you are about to send the SMS, say exactly: "I'll send that by text right now."
- After the tool succeeds, confirm briefly that the text was sent and say the code aloud once.
- Once the customer confirms the SMS arrived or says they will use it, close the call politely in one short sentence.

${memoryBlock ? `\n\n${memoryBlock}\n` : ""}

${merchantBlock ? `\n\n${merchantBlock}\n` : ""}

Playbook:
- Tone: ${playbook.tone}. ${toneGuidance(playbook.tone)}
- ${goalGuidance(playbook.goal)}
- ${offerGuidance({
    discountEnabled: playbook.discountEnabled,
    maxDiscountPercent: playbook.maxDiscountPercent,
    offerRule: playbook.offerRule,
    minCartValueForDiscount: playbook.minCartValueForDiscount,
    couponPrefix: playbook.couponPrefix,
    couponValidityHours: playbook.couponValidityHours,
    freeShippingEnabled: playbook.freeShippingEnabled,
  })}
- ${followupGuidance({
    followupEmailEnabled: playbook.followupEmailEnabled,
    followupSmsEnabled: playbook.followupSmsEnabled,
    maxFollowupQuestions: playbook.maxFollowupQuestions,
  })}
${smsBlock ? `\n\n${smsBlock}\n` : ""}

Context:
- checkoutId: ${checkout.checkoutId}
- customerName: ${checkout.customerName ?? "-"}
- email: ${checkout.email ?? "-"}
- phone_e164: ${checkout.phone ?? "-"}
- cartTotal: ${checkout.value} ${checkout.currency}
- cartItems:
${cartText}

Offer context (use these exact fields):
- CHECKOUT_LINK: ${checkoutLink ?? "-"}
- OFFER_CODE: ${offerCode ?? "-"}
- PERCENT: ${discountPercent == null ? "-" : String(Math.floor(Number(discountPercent) || 0))}
- VALIDITY_HOURS: ${String(Math.floor(Number(validityHours) || 24))}
`.trim();

  if (mode === "replace" && merchant) {
    return `${merchant}\n\n${base}`.trim();
  }

  return base;
}

/* =========================
   Brevo Transactional SMS
   ========================= */
function pickBrevoApiKey() {
  return String(process.env.BREVO_API_KEY ?? process.env.BREVO_SMS_API_KEY ?? "").trim();
}

function normalizeBrevoRecipient(e164: string) {
  return String(e164 ?? "").trim().replace(/[^\d+]/g, "").replace(/^\+/, "");
}

function normalizeBrevoSender(sender: string) {
  const raw = String(sender ?? "").trim();
  if (!raw) return "";

  const noSpace = raw.replace(/\s+/g, "");
  if (/^\+?\d+$/.test(noSpace)) {
    const digits = noSpace.replace(/^\+/, "").replace(/[^\d]/g, "");
    return digits.slice(0, 15);
  }

  const alpha = noSpace.replace(/[^A-Za-z0-9]/g, "");
  return alpha.slice(0, 11);
}

function resolveBrevoSender(extras: ExtrasRow | null) {
  const fromDb = String(extras?.brevoSmsSender ?? "").trim();
  const fromEnv = String(
    process.env.BREVO_SMS_SENDER ??
      process.env.BREVO_SENDER ??
      process.env.VAPI_SMS_SENDER ??
      process.env.VAPI_SMS_FROM_NUMBER ??
      ""
  ).trim();

  const picked = fromDb || fromEnv;
  return normalizeBrevoSender(picked);
}

function normalizeBrevoType(t: any) {
  const v = String(t ?? "").trim().toLowerCase();
  if (v === "marketing") return "marketing";
  return "transactional";
}

async function brevoSendSms(params: {
  toE164: string;
  body: string;
  sender: string;
  type?: string | null;
  tag?: string | null;
  organisationPrefix?: string | null;
  unicodeEnabled?: boolean;
}) {
  const apiKey = pickBrevoApiKey();
  if (!apiKey) throw new Error("Missing env: BREVO_API_KEY");

  const sender = normalizeBrevoSender(params.sender);
  if (!sender) throw new Error("Missing Brevo sender (set Settings.brevoSmsSender or BREVO_SMS_SENDER).");

  const recipient = normalizeBrevoRecipient(params.toE164);
  if (!recipient) throw new Error("Invalid recipient phone");

  const payload: Record<string, any> = {
    sender,
    recipient,
    content: String(params.body ?? "").trim(),
    type: normalizeBrevoType(params.type ?? process.env.BREVO_SMS_TYPE),
  };

  const tag = String(params.tag ?? process.env.BREVO_SMS_TAG ?? "").trim();
  if (tag) payload.tag = tag;

  const organisationPrefix = String(params.organisationPrefix ?? process.env.BREVO_SMS_ORGANISATION_PREFIX ?? "").trim();
  if (organisationPrefix) payload.organisationPrefix = organisationPrefix;

  const unicodeEnabled =
    typeof params.unicodeEnabled === "boolean"
      ? params.unicodeEnabled
      : String(process.env.BREVO_SMS_UNICODE ?? "").trim().toLowerCase() === "true";
  if (unicodeEnabled) payload.unicodeEnabled = true;

  const res = await fetch("https://api.brevo.com/v3/transactionalSMS/send", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(`Brevo SMS failed HTTP ${res.status}: ${text.slice(0, 900)}`);
  }

  return json;
}

/* =========================
   Vapi Tools webhook handler (for /api/vapi-tools)
   ========================= */
function pickBearerToken(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export async function handleVapiToolsWebhook(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const internalExpected = String(process.env.INTERNAL_API_SECRET ?? "").trim();
  const gotInternal = String(request.headers.get("x-internal-secret") ?? "").trim();
  const internalOk = Boolean(internalExpected && gotInternal && gotInternal === internalExpected);

  if (!internalOk) {
    const expectedBearer = String(
      process.env.VAPI_TOOL_BEARER_TOKEN ?? process.env.VAPI_WEBHOOK_BEARER_TOKEN ?? ""
    ).trim();
    const expectedSecret = String(process.env.VAPI_WEBHOOK_SECRET ?? "").trim();

    if (expectedBearer) {
      const got = pickBearerToken(request);
      if (!got || got !== expectedBearer) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (expectedSecret) {
      const gotSecret = String(url.searchParams.get("secret") ?? "").trim();
      if (!gotSecret || gotSecret !== expectedSecret) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  }

  const payload = await request.json().catch(() => null);
  if (!payload) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const msg = payload?.message ?? payload ?? {};
  const messageType = String(msg?.type ?? msg?.messageType ?? msg?.event ?? "").trim();

  const toolCalls: Array<{ id: string; name: string; arguments: any }> = [];

  for (const tc of Array.isArray(msg?.toolCallList) ? msg.toolCallList : []) {
    toolCalls.push({
      id: String(tc?.id ?? "").trim(),
      name: String(tc?.name ?? "").trim(),
      arguments: tc?.arguments ?? tc?.parameters ?? {},
    });
  }

  for (const tc of Array.isArray(msg?.toolCalls) ? msg.toolCalls : []) {
    const fn = tc?.function ?? {};
    toolCalls.push({
      id: String(tc?.id ?? "").trim(),
      name: String(tc?.name ?? fn?.name ?? "").trim(),
      arguments: tc?.arguments ?? fn?.arguments ?? tc?.parameters ?? {},
    });
  }

  for (const x of Array.isArray(msg?.toolWithToolCallList) ? msg.toolWithToolCallList : []) {
    const tc = x?.toolCall ?? {};
    const fn = tc?.function ?? {};
    toolCalls.push({
      id: String(tc?.id ?? "").trim(),
      name: String(x?.name ?? tc?.name ?? fn?.name ?? "").trim(),
      arguments: tc?.arguments ?? fn?.arguments ?? tc?.parameters ?? {},
    });
  }

  if (messageType && messageType !== "tool-calls") {
    return new Response(JSON.stringify({ ok: true, ignored: messageType }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const call = msg?.call ?? payload?.call ?? null;
  const meta =
    call?.assistant?.metadata ||
    call?.assistant?.assistant?.metadata ||
    call?.metadata ||
    payload?.assistant?.metadata ||
    null;

  const shop = String(meta?.shop ?? payload?.shop ?? "").trim();
  const callJobId = String(meta?.callJobId ?? payload?.callJobId ?? "").trim();

  const results: Array<{ name: string; toolCallId: string; result?: string; error?: string }> = [];

  function parseArgs(raw: any) {
    if (!raw) return {};
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }
    return typeof raw === "object" ? raw : {};
  }

  for (const tc of toolCalls.filter((x) => x.id && x.name)) {
    const toolName = String(tc.name).trim();

    if (toolName !== "send_checkout_offer" && toolName !== "send_checkout_sms") {
      results.push({
        name: toolName,
        toolCallId: tc.id,
        result: JSON.stringify({ ok: true, ignored: true }),
      });
      continue;
    }

    try {
      if (!shop) throw new Error("Missing shop in metadata.");
      if (!callJobId) throw new Error("Missing callJobId in metadata.");

      const job = await db.callJob.findFirst({ where: { id: callJobId, shop } });
      if (!job) throw new Error("CallJob not found.");

      const args = parseArgs(tc.arguments);

      const requestedType = (
        toolName === "send_checkout_sms"
          ? "link_only"
          : ["link_only", "discount", "free_shipping"].includes(
              String(args?.offerType ?? "").trim().toLowerCase()
            )
            ? String(args?.offerType ?? "").trim().toLowerCase()
            : "link_only"
      ) as "link_only" | "discount" | "free_shipping";

      const sendSms = toolName === "send_checkout_sms" ? true : args?.sendSms !== false;
      if (!sendSms) throw new Error("Tool called with sendSms=false.");

      const requestedDiscountPercent = Math.floor(Number(args?.discountPercent ?? 0));

      const cacheKey = makeToolResultCacheKey(shop, callJobId, tc.id);
      const memoryCached = getRecentToolResult(cacheKey);
      if (memoryCached) {
        results.push({
          name: toolName,
          toolCallId: tc.id,
          result: memoryCached,
        });
        continue;
      }

      const existingAnalysis = readAnalysisJsonObject(job.analysisJson ?? null);
      const existingOffer =
        existingAnalysis?.offer && typeof existingAnalysis.offer === "object"
          ? existingAnalysis.offer
          : null;

      const sameRecentOffer =
        existingOffer &&
        existingOffer.smsSentAt &&
        existingOffer.smsMessageSid &&
        isRecentIso(existingOffer.smsSentAt, 5 * 60 * 1000) &&
        (
          existingOffer.lastToolCallId === tc.id ||
          (
            String(existingOffer.offerType ?? "") === requestedType &&
            (
              requestedType !== "discount" ||
              Number(existingOffer.discountPercent ?? 0) === requestedDiscountPercent
            )
          )
        );

      if (sameRecentOffer) {
        const reused = buildToolSuccessResult({
          messageId: String(existingOffer.smsMessageSid ?? "").trim() || null,
          offerType: (String(existingOffer.offerType ?? "link_only") as
            | "link_only"
            | "discount"
            | "free_shipping"),
          code: String(existingOffer.offerCode ?? "").trim() || null,
          discountPercent:
            existingOffer.discountPercent == null ? null : Number(existingOffer.discountPercent),
        });

        setRecentToolResult(cacheKey, reused);

        results.push({
          name: toolName,
          toolCallId: tc.id,
          result: reused,
        });
        continue;
      }

      let checkout = await db.checkout.findFirst({ where: { shop, checkoutId: job.checkoutId } });
      if (!checkout) {
        await backfillCheckoutFromShopify(shop, String(job.checkoutId));
        checkout = await db.checkout.findFirst({ where: { shop, checkoutId: job.checkoutId } });
      }
      if (!checkout) throw new Error("Checkout not found.");

      const extras = await readSettingsExtras(shop);

      const playbook = {
        discountEnabled: Boolean(extras?.discount_enabled ?? false),
        maxDiscountPercent: clamp(Number(extras?.max_discount_percent ?? 10), 0, 50),
        minCartValueForDiscount:
          extras?.min_cart_value_for_discount == null ? null : Number(extras.min_cart_value_for_discount),
        couponPrefix: (extras?.coupon_prefix ?? "").trim() ? String(extras?.coupon_prefix).trim() : null,
        couponValidityHours: clamp(Number(extras?.coupon_validity_hours ?? 24), 1, 168),
        freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),
        followupSmsEnabled: Boolean(extras?.followup_sms_enabled ?? false),
      };

      if (!playbook.followupSmsEnabled) throw new Error("SMS follow-up is disabled for this shop.");

      const recoveryUrl = extractRecoveryUrlFromCheckoutRaw(checkout.raw);
      if (!recoveryUrl) throw new Error("Missing recovery checkout URL.");

      const compactLink = compactCheckoutUrl(recoveryUrl);

      const to = String(job.phone ?? "").trim();
      if (!to || !to.startsWith("+")) throw new Error("Missing/invalid E.164 recipient on CallJob.");

      const brevoKey = pickBrevoApiKey();
      const smsSender = resolveBrevoSender(extras);
      const hasSmsTransport = Boolean(brevoKey && smsSender);
      if (!hasSmsTransport) throw new Error("SMS transport is not configured (Brevo).");

      let finalType: "link_only" | "discount" | "free_shipping" = "link_only";
      let finalDiscountPercent: number | null = null;
      let offerCode: string | null = null;
      let discountNodeId: string | null = null;
      let offerCreateError: string | null = null;
      let discountLink: string = compactLink;

      if (requestedType === "discount") {
        if (!playbook.discountEnabled) throw new Error("Discounts are disabled for this shop.");

        if (
          playbook.minCartValueForDiscount != null &&
          Number(checkout.value) < Number(playbook.minCartValueForDiscount)
        ) {
          throw new Error("Cart total does not meet the minimum value for discount.");
        }

        if (!Number.isFinite(requestedDiscountPercent) || requestedDiscountPercent <= 0) {
          throw new Error("A positive discountPercent is required.");
        }

        if (requestedDiscountPercent > playbook.maxDiscountPercent) {
          throw new Error(`Requested discountPercent exceeds the max of ${playbook.maxDiscountPercent}.`);
        }

        try {
          const accessToken = await getOfflineAccessToken(shop);
          const customerGid = await findCustomerGidByEmail(shop, accessToken, checkout.email);

          let created: { nodeId: string; createdCode: string | null } | null = null;
          let candidate: string | null = null;
          let lastErr: any = null;

          for (let i = 0; i < 8; i++) {
            candidate = makeUniqueCode({ prefix: playbook.couponPrefix });
            try {
              created = await createDiscountCodeBasic({
                shop,
                accessToken,
                code: candidate,
                percent: requestedDiscountPercent,
                startsAt: new Date().toISOString(),
                endsAt: hoursFromNowIso(playbook.couponValidityHours),
                customerGid,
                minSubtotal: playbook.minCartValueForDiscount,
              });
              break;
            } catch (e: any) {
              lastErr = e;
              if (!isLikelyDuplicateDiscountCodeError(e)) throw e;
            }
          }

          if (!created || !candidate) {
            throw lastErr ?? new Error("Could not create Shopify discount code.");
          }

          offerCode = created.createdCode ?? candidate;
          discountNodeId = created.nodeId;
          finalDiscountPercent = requestedDiscountPercent;
          finalType = "discount";
          discountLink = compactLink;
        } catch (e: any) {
          offerCreateError = String(e?.message ?? e);
          throw new Error(`Could not create Shopify discount code: ${offerCreateError}`);
        }
      } else if (requestedType === "free_shipping") {
        if (!playbook.freeShippingEnabled) throw new Error("Free shipping offers are disabled for this shop.");

        if (
          playbook.minCartValueForDiscount != null &&
          Number(checkout.value) < Number(playbook.minCartValueForDiscount)
        ) {
          throw new Error("Cart total does not meet the minimum value for offer.");
        }

        try {
          const accessToken = await getOfflineAccessToken(shop);
          const customerGid = await findCustomerGidByEmail(shop, accessToken, checkout.email);

          let created: { nodeId: string; createdCode: string | null } | null = null;
          let candidate: string | null = null;
          let lastErr: any = null;

          for (let i = 0; i < 8; i++) {
            candidate = makeUniqueCodeSimple({ prefix: playbook.couponPrefix ?? "C" });
            try {
              created = await createDiscountCodeFreeShipping({
                shop,
                accessToken,
                code: candidate,
                startsAt: new Date().toISOString(),
                endsAt: hoursFromNowIso(playbook.couponValidityHours),
                customerGid,
                minSubtotal: playbook.minCartValueForDiscount,
              });
              break;
            } catch (e: any) {
              lastErr = e;
              if (!isLikelyDuplicateDiscountCodeError(e)) throw e;
            }
          }

          if (!created || !candidate) {
            throw lastErr ?? new Error("Could not create Shopify free shipping code.");
          }

          offerCode = created.createdCode ?? candidate;
          discountNodeId = created.nodeId;
          finalType = "free_shipping";
          discountLink = compactLink;
        } catch (e: any) {
          offerCreateError = String(e?.message ?? e);
          throw new Error(`Could not create Shopify free shipping code: ${offerCreateError}`);
        }
      }

      const percentForTemplate =
        finalType === "discount" && finalDiscountPercent != null
          ? String(Math.floor(Number(finalDiscountPercent)))
          : "";

      const vars: Record<string, string> = {
        shop,
        shop_name: shop,
        customer_name: String(checkout.customerName ?? "").trim() || "Customer",
        checkout_id: String(checkout.checkoutId),
        checkout_link: compactLink,
        discount_link: compactLink,
        offer_code: String(offerCode ?? ""),
        percent: percentForTemplate,
        validity_hours: String(Math.floor(Number(playbook.couponValidityHours || 24))),
      };

      const smsText = buildSmsText({
        templateOffer: extras?.sms_template_offer ?? null,
        templateNoOffer: extras?.sms_template_no_offer ?? null,
        vars,
        hasOffer: Boolean(offerCode),
      });

      const br = await brevoSendSms({
        toE164: to,
        body: smsText,
        sender: smsSender,
        type: process.env.BREVO_SMS_TYPE ?? "transactional",
        tag: process.env.BREVO_SMS_TAG ?? "checkout-recovery",
        organisationPrefix: process.env.BREVO_SMS_ORGANISATION_PREFIX ?? null,
      });

      const messageId = String(br?.messageId ?? "").trim() || null;

      const successResult = buildToolSuccessResult({
        messageId,
        offerType: finalType,
        code: offerCode ?? null,
        discountPercent: finalDiscountPercent,
      });

      await db.callJob.update({
        where: { id: job.id },
        data: {
          analysisJson: mergeAnalysisJson(job.analysisJson ?? null, {
            offer: {
              ...(existingOffer && typeof existingOffer === "object" ? existingOffer : {}),
              checkoutLink: compactLink,
              discountLink,
              offerType: finalType,
              offerCode,
              discountPercent: finalDiscountPercent,
              couponValidityHours: playbook.couponValidityHours,
              shopifyDiscountNodeId: discountNodeId,
              offerCreateError,
              generatedAt: new Date().toISOString(),
              smsEnabled: true,
              smsFrom: smsSender || null,
              smsText,
              smsSentAt: new Date().toISOString(),
              smsMessageSid: messageId,
              compactCheckoutLink: compactLink,
              lastToolCallId: tc.id,
              lastRequestedType: requestedType,
              lastResult: safeJsonParse(successResult) ?? null,
            },
          }),
        },
      });

      setRecentToolResult(cacheKey, successResult);

      results.push({
        name: toolName,
        toolCallId: tc.id,
        result: successResult,
      });
    } catch (e: any) {
      results.push({
        name: toolName,
        toolCallId: tc.id,
        error: String(e?.message ?? e),
      });
    }
  }

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/* =========================
   Vapi call
   ========================= */
export async function startVapiCallForJob(params: { shop: string; callJobId: string }) {
  const VAPI_API_KEY = requiredEnv("VAPI_API_KEY");
  const VAPI_SERVER_URL = requiredEnv("VAPI_SERVER_URL");

  const job = await db.callJob.findFirst({ where: { id: params.callJobId, shop: params.shop } });
  if (!job) throw new Error("CallJob not found");

  let checkout = await db.checkout.findFirst({ where: { shop: params.shop, checkoutId: job.checkoutId } });
  if (!checkout) {
    await backfillCheckoutFromShopify(params.shop, String(job.checkoutId));
    checkout = await db.checkout.findFirst({ where: { shop: params.shop, checkoutId: job.checkoutId } });
  }
  if (!checkout) throw new Error("Checkout not found");

  const checkoutPhoneRaw = (checkout as any).phone ?? null;
  const jobPhoneRaw = (job as any).phone ?? null;
  const inferredIso2 = inferIso2FromCheckoutRaw((checkout as any).raw ?? null);
  const inferredCallingCode = inferCallingCodeFromCheckoutRaw((checkout as any).raw ?? null);

  const rawPhone = checkoutPhoneRaw ?? jobPhoneRaw;
  const customerNumber = normalizePhoneE164(rawPhone, inferredCallingCode);

  if (!customerNumber) {
    await db.callJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        outcome: `INVALID_PHONE_E164: raw=${String(rawPhone ?? "")} inferredIso2=${String(inferredIso2 ?? "")}`,
        analysisJson: mergeAnalysisJson(job.analysisJson ?? null, {
          phone_validation: {
            rawPhone,
            checkoutPhoneRaw,
            jobPhoneRaw,
            inferredIso2,
            inferredCallingCode,
            at: new Date().toISOString(),
          },
        }),
      },
    });
    throw new Error("Invalid customer phone (E.164 required).");
  }

  const settings = await db.settings.findUnique({ where: { shop: params.shop } });
  const extras = await readSettingsExtras(params.shop);

  const playbook = {
    tone: pickTone(extras?.tone ?? "neutral"),
    goal: pickGoal(extras?.goal ?? "complete_checkout"),
    maxCallSeconds: clamp(Number(extras?.max_call_seconds ?? 120), 45, 300),
    maxFollowupQuestions: clamp(Number(extras?.max_followup_questions ?? 1), 0, 3),

    discountEnabled: Boolean(extras?.discount_enabled ?? false),
    maxDiscountPercent: clamp(Number(extras?.max_discount_percent ?? 10), 0, 50),
    offerRule: pickOfferRule(extras?.offer_rule ?? "ask_only"),
    minCartValueForDiscount:
      extras?.min_cart_value_for_discount == null ? null : Number(extras.min_cart_value_for_discount),
    couponPrefix: (extras?.coupon_prefix ?? "").trim() ? String(extras?.coupon_prefix).trim() : null,
    couponValidityHours: clamp(Number(extras?.coupon_validity_hours ?? 24), 1, 168),
    freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),

    followupEmailEnabled: Boolean(extras?.followup_email_enabled ?? true),
    followupSmsEnabled: Boolean(extras?.followup_sms_enabled ?? false),
  };

  const priorCallsCount = await db.callJob.count({
    where: { shop: params.shop, checkoutId: job.checkoutId, id: { not: job.id } },
  });
  const attemptNumber = priorCallsCount + 1;

  const previousMemory =
    attemptNumber >= 2
      ? await readPreviousCallMemory({
          shop: params.shop,
          checkoutId: job.checkoutId,
          currentCallJobId: job.id,
        })
      : null;

  const recoveryUrl = extractRecoveryUrlFromCheckoutRaw(checkout.raw);
  const compactRecoveryUrl = recoveryUrl ? compactCheckoutUrl(recoveryUrl) : null;

  const brevoKey = pickBrevoApiKey();
  const smsSender = resolveBrevoSender(extras);
  const hasSmsTransport = Boolean(brevoKey && smsSender);

  const smsEnabled =
    Boolean(playbook.followupSmsEnabled) && hasSmsTransport && Boolean(compactRecoveryUrl) && Boolean(customerNumber);

  const merchantPrompt = String((settings as any)?.merchantPrompt ?? (settings as any)?.userPrompt ?? "");
  const configuredPromptMode = pickPromptMode((settings as any)?.promptMode ?? "replace");
  const promptMode: PromptMode = merchantPrompt.trim() ? configuredPromptMode : "replace";

  const speakableName = firstNameOnly(checkout.customerName) ?? checkout.customerName ?? null;

  const systemPrompt = buildSystemPrompt({
    merchantPrompt,
    promptMode,
    attemptNumber,
    previousMemory,
    smsEnabled,
    offer: {
      checkoutLink: compactRecoveryUrl ?? null,
      offerCode: null,
      discountPercent: null,
      couponValidityHours: playbook.couponValidityHours,
    },
    checkout: {
      checkoutId: String(checkout.checkoutId),
      customerName: speakableName,
      email: checkout.email,
      phone: customerNumber,
      value: checkout.value,
      currency: checkout.currency,
      itemsJson: checkout.itemsJson,
    },
    playbook,
  });

  const factsBlock =
    promptMode === "replace" && merchantPrompt.trim()
      ? buildFactsBlock({
          attemptNumber,
          previousMemory,
          checkout: {
            checkoutId: String(checkout.checkoutId),
            customerName: speakableName,
            email: checkout.email,
            phone: customerNumber,
            value: checkout.value,
            currency: checkout.currency,
            itemsJson: checkout.itemsJson,
          },
          playbook,
        })
      : null;

  const messages: Array<{ role: "system" | "user"; content: string }> = [{ role: "system", content: systemPrompt }];

  if (factsBlock) messages.push({ role: "user", content: factsBlock });

  if (smsEnabled) {
    messages.push({
      role: "user",
      content:
        `There is no pre-created code yet. If you decide to offer a discount, you must choose the exact percentage during the call and then use the tool to create the real Shopify code after the customer agrees.`,
    });

    messages.push({
      role: "user",
      content:
        `If the customer wants the link or code by SMS, or accepts your proposed next step, call tool send_checkout_offer exactly once. ` +
        `Choose offerType as one of: link_only, discount, free_shipping. ` +
        `If you choose discount, choose the exact discountPercent yourself based on the conversation, but never exceed ${playbook.maxDiscountPercent}% and only use a positive integer. ` +
        `Do not promise that a code exists until the tool succeeds.`,
    });

    messages.push({
      role: "user",
      content:
        `If you need to send the SMS, first say exactly "I'll send that by text right now." and then call the tool. ` +
        `After the tool succeeds, say that the text was sent and say the code aloud clearly one time. ` +
        `Never read the checkout URL aloud. Never spell the domain. Never read query parameters aloud.`,
    });
  }

  messages.push({
    role: "user",
    content:
      attemptNumber >= 2
        ? "Follow-up call. Reference previous context if relevant. Keep it short and move to a concrete next step."
        : "Start the call now. Greet the customer, mention they almost completed checkout, and ask if they want help finishing the order.",
  });

  const nextAnalysisJson = mergeAnalysisJson(job.analysisJson ?? null, {
    offer: {
      checkoutLink: compactRecoveryUrl,
      discountLink: compactRecoveryUrl,
      offerType: null,
      offerCode: null,
      discountPercent: null,
      couponValidityHours: playbook.couponValidityHours,
      shopifyDiscountNodeId: null,
      offerCreateError: null,
      generatedAt: new Date().toISOString(),
      smsEnabled,
      smsFrom: smsEnabled ? smsSender : null,
      smsText: null,
      smsSentAt: null,
      smsMessageSid: null,
      lastToolCallId: null,
      lastRequestedType: null,
      lastResult: null,
    },
    phone_resolution: {
      rawPhone,
      checkoutPhoneRaw,
      jobPhoneRaw,
      resolvedE164: customerNumber,
      inferredIso2,
      inferredCallingCode,
      at: new Date().toISOString(),
    },
  });

  await db.callJob.update({
    where: { id: job.id },
    data: {
      status: "CALLING",
      provider: "vapi",
      outcome: null,
      analysisJson: nextAnalysisJson,
      phone: customerNumber,
    },
  });

  const webhookSecret = String(process.env.VAPI_WEBHOOK_SECRET ?? "").trim();
  const webhookBaseUrl = VAPI_SERVER_URL.replace(/\/$/, "");
  const webhookUrl = webhookSecret
    ? `${webhookBaseUrl}${webhookBaseUrl.includes("?") ? "&" : "?"}secret=${encodeURIComponent(webhookSecret)}`
    : webhookBaseUrl;

  const assistantId =
    String((extras as any)?.vapi_assistant_id ?? (extras as any)?.vapiAssistantId ?? "").trim() ||
    process.env.VAPI_ASSISTANT_ID ||
    requiredEnv("VAPI_ASSISTANT_ID");

  const phoneNumberId =
    String((extras as any)?.vapi_phone_number_id ?? (extras as any)?.vapiPhoneNumberId ?? "").trim() ||
    process.env.VAPI_PHONE_NUMBER_ID ||
    requiredEnv("VAPI_PHONE_NUMBER_ID");

  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VAPI_API_KEY}`,
      Accept: "application/json",
    },
    body: JSON.stringify({
      phoneNumberId,
      assistantId,

      customer: {
        number: customerNumber,
        name: speakableName ?? undefined,
      },

      assistant: {
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages,
          ...(smsEnabled
            ? {
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "send_checkout_offer",
                      description:
                        "Send the checkout link by SMS. Optionally create a real Shopify discount or free-shipping code and send it by SMS.",
                      parameters: {
                        type: "object",
                        properties: {
                          offerType: {
                            type: "string",
                            enum: ["link_only", "discount", "free_shipping"],
                            description: "The final offer you decided to send.",
                          },
                          discountPercent: {
                            type: "integer",
                            description:
                              "Required only when offerType=discount. Must be a positive integer within the configured limit.",
                          },
                          sendSms: {
                            type: "boolean",
                            description: "Set true when the customer accepted receiving the SMS.",
                          },
                        },
                        required: ["offerType", "sendSms"],
                      },
                    },
                  },
                ],
              }
            : {}),
        },

        serverUrl: webhookUrl,
        serverMessages: ["status-update", "end-of-call-report", 'transcript[transcriptType="final"]', "tool-calls"],

        metadata: {
          shop: params.shop,
          callJobId: job.id,
          checkoutId: job.checkoutId,
          promptMode,
        },
      },

      metadata: {
        shop: params.shop,
        callJobId: job.id,
        checkoutId: job.checkoutId,
        promptMode,
      },
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    await db.callJob.update({
      where: { id: job.id },
      data: { status: "FAILED", outcome: `VAPI_ERROR: ${JSON.stringify(json)}` },
    });
    throw new Error(`Vapi create call failed: ${JSON.stringify(json)}`);
  }

  const providerCallId = String(json?.id ?? json?.call?.id ?? "");

  await db.callJob.update({
    where: { id: job.id },
    data: { providerCallId: providerCallId || null, outcome: "VAPI_CALL_CREATED", status: "CALLING" },
  });

  return { ok: true, providerCallId, raw: json };
}

export async function createVapiCallForJob(params: { shop: string; callJobId: string }) {
  return startVapiCallForJob(params);
}

export async function placeCall(_params: {
  shop: string;
  phone: string;
  checkoutId: string;
  customerName?: string | null;
  items?: Array<{ title: string; quantity?: number }> | null;
  amount?: number | null;
  currency?: string | null;
}) {
  throw new Error("placeCall not wired. Use CallJob pipeline + /api/run-calls.");
}