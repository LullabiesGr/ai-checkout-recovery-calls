// app/callProvider.server.ts
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
  return "append";
}

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

function toneGuidance(tone: Tone) {
  if (tone === "friendly") return "Warm, helpful, human. Short sentences. Light humor allowed if the customer engages.";
  if (tone === "premium") return "Calm, confident, concierge-style. Precise language. No slang. Respectful pacing.";
  if (tone === "urgent") return "Direct and efficient. Time-boxed. Clear next step. No rambling.";
  return "Neutral, professional, helpful.";
}

function goalGuidance(goal: Goal) {
  if (goal === "qualify_and_follow_up") {
    return "Goal: qualify intent fast, then secure permission for follow-up (email/SMS) if they won't complete now.";
  }
  if (goal === "support_only") {
    return "Goal: support only. Do not offer discounts proactively unless asked. Focus on help, trust, and logistics.";
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
    ? "Free shipping: allowed as alternative offer (use it instead of discount when appropriate)."
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

// =========================
// Follow-up memory helpers
// =========================

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

// =========================
// Phone normalization (E.164)
// =========================
function normalizePhoneE164(raw: any): string | null {
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

  // Heuristics for common cases
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits; // US/CA
  if (digits.length === 10 && (digits.startsWith("69") || digits.startsWith("2"))) return "+30" + digits; // GR
  if (digits.length === 10 && digits.startsWith("0") && (digits[1] === "6" || digits[1] === "2"))
    return "+30" + digits.slice(1);

  if (digits.length >= 11 && digits.length <= 15) return "+" + digits;

  return null;
}

async function readPreviousCallMemory(params: {
  shop: string;
  checkoutId: string;
  currentCallJobId: string;
}): Promise<string | null> {
  const { shop, checkoutId, currentCallJobId } = params;

  // Prefer vapi_call_summaries (safe minimal columns). If query fails, fallback to CallJob.
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

  // Fallback to CallJob fields
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

// =========================
// Offer/SMS helpers
// =========================

function safeJsonParse(s: any): any | null {
  try {
    if (!s) return null;
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}

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

function appendDiscountParam(urlStr: string, code: string) {
  try {
    const u = new URL(urlStr);
    u.searchParams.set("discount", code);
    return u.toString();
  } catch {
    return urlStr;
  }
}

function normalizePrefix(prefix: string | null) {
  const p = String(prefix ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return p.slice(0, 10) || "OFFER";
}

function codeFragmentFromCustomerName(name: string | null | undefined) {
  let s = String(name ?? "").trim();
  if (!s) return "VIP";
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return s.slice(0, 10) || "VIP";
}

function makeUniqueCode(args: { customerName?: string | null; percent: number; prefix?: string | null }) {
  const nameFrag = codeFragmentFromCustomerName(args.customerName);
  const pct = Math.max(1, Math.min(99, Math.floor(Number(args.percent) || 0)));
  const pfx = normalizePrefix(args.prefix ?? "OFFER").slice(0, 8);
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `${pfx}-${nameFrag}-${pct}-${rand}`.slice(0, 45);
}

function buildSmsText(args: {
  checkoutLink: string | null;
  offerCode: string | null;
  discountPercent: number | null;
  couponValidityHours: number;
}) {
  const link = args.checkoutLink ? String(args.checkoutLink) : "";
  const code = args.offerCode ? String(args.offerCode) : "";
  const pct = args.discountPercent == null ? "" : `${Math.floor(Number(args.discountPercent) || 0)}%`;
  const validity = clamp(Number(args.couponValidityHours || 24), 1, 168);

  if (link && code && pct) {
    return `Finish your checkout: ${link}\nOffer: ${pct} off\nCode: ${code}\nValid: ${validity}h`;
  }
  return link ? `Finish your checkout: ${link}` : `Finish your checkout using the link from the call.`;
}

// =========================
// Shopify Discount Creation
// =========================

const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION ?? "2026-01";

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

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function findCustomerGidByEmail(shop: string, accessToken: string, email: string | null): Promise<string | null> {
  const e = String(email ?? "").trim();
  if (!e) return null;

  const q = `
    query FindCustomer($query: String!) {
      customers(first: 1, query: $query) {
        nodes { id email }
      }
    }
  `;
  const data = await shopifyGraphql(shop, accessToken, q, { query: `email:${e}` });
  const id = data?.data?.customers?.nodes?.[0]?.id;
  return id ? String(id) : null;
}

function hoursFromNowIso(hours: number) {
  const h = Math.max(1, Math.min(168, Math.floor(Number(hours) || 24)));
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

async function createDiscountCodeBasic(params: {
  shop: string;
  accessToken: string;
  code: string;
  percent: number;
  startsAt: string;
  endsAt: string | null;
  customerGid: string | null;
}) {
  const mutation = `
    mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
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
    endsAt: params.endsAt,
    appliesOncePerCustomer: true,
    customerSelection: params.customerGid ? { customers: { add: [params.customerGid] } } : { all: true },
    customerGets: { value: { percentage }, items: { all: true } },
  };

  const out = await shopifyGraphql(params.shop, params.accessToken, mutation, { basicCodeDiscount });

  const errs = out?.data?.discountCodeBasicCreate?.userErrors ?? [];
  const nodeId = out?.data?.discountCodeBasicCreate?.codeDiscountNode?.id ?? null;
  const createdCode =
    out?.data?.discountCodeBasicCreate?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ?? null;

  return {
    nodeId: nodeId ? String(nodeId) : null,
    createdCode: createdCode ? String(createdCode) : null,
    userErrors: errs as Array<{ field?: string[]; message: string }>,
  };
}

// =========================
// Prompt builder
// =========================

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
  lines.push(`phone: ${checkout.phone ?? "-"}`);
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

  // PromptMode behavior
  // - default_only: ignore merchantPrompt entirely
  // - replace: system prompt becomes only merchantPrompt (fallback to base if empty)
  // - append: merchantPrompt becomes HIGHEST PRIORITY instructions (still below Hard rules)
  const mode = pickPromptMode(args.promptMode ?? "append");
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
- Continue from the customer's last intent/objections.
- If memory is unclear, ask one confirmation question max, then proceed.
`.trim()
    : "";

  const offer = args.offer;
  const checkoutLink = offer?.checkoutLink ? offer.checkoutLink : null;
  const offerCode = offer?.offerCode ? offer.offerCode : null;
  const discountPercent = offer?.discountPercent ?? null;

  const merchantBlock =
    mode === "append" && merchant
      ? `
MERCHANT INSTRUCTIONS (HIGHEST PRIORITY)
You MUST follow these instructions exactly.
- If they conflict with the "Hard rules" section, follow Hard rules.
- Otherwise, these instructions override any other guidance (tone/goal/playbook defaults).

${merchant}
`.trim()
      : "";

  const smsBlock =
    args.smsEnabled && checkoutLink
      ? `
SMS (tool use):
- If the customer asks for the link or coupon code OR explicitly agrees to receive it by SMS, send exactly ONE SMS using the sms tool.
- Do not send SMS if the customer declines.
- Do not send multiple SMS messages.
- Use: to=<customer number> and message=<pre-approved text from the user message>.
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
- Checkout ID: ${checkout.checkoutId}
- Customer name: ${checkout.customerName ?? "-"}
- Email: ${checkout.email ?? "-"}
- Cart total: ${checkout.value} ${checkout.currency}
- Cart items:
${cartText}

Offer context:
- Checkout link: ${checkoutLink ?? "-"}
- Offer percent: ${discountPercent == null ? "-" : `${Math.floor(Number(discountPercent) || 0)}%`}
- Offer code: ${offerCode ?? "-"}
`.trim();

  if (mode === "replace") return merchant ? merchant : base;
  return base;
}

// =========================
// Vapi call
// =========================

export async function startVapiCallForJob(params: { shop: string; callJobId: string }) {
  const VAPI_API_KEY = requiredEnv("VAPI_API_KEY");
  const VAPI_ASSISTANT_ID = requiredEnv("VAPI_ASSISTANT_ID");
  const VAPI_PHONE_NUMBER_ID = requiredEnv("VAPI_PHONE_NUMBER_ID");
  const VAPI_SERVER_URL = requiredEnv("VAPI_SERVER_URL");

  const job = await db.callJob.findFirst({ where: { id: params.callJobId, shop: params.shop } });
  if (!job) throw new Error("CallJob not found");

  const checkout = await db.checkout.findFirst({ where: { shop: params.shop, checkoutId: job.checkoutId } });
  if (!checkout) throw new Error("Checkout not found");

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

  const minOk =
    playbook.minCartValueForDiscount == null ? true : Number(checkout.value) >= Number(playbook.minCartValueForDiscount);

  const discountPercent = playbook.discountEnabled && minOk ? Number(playbook.maxDiscountPercent || 0) : 0;

  const existingOffer = safeJsonParse(job.analysisJson)?.offer ?? null;
  let offerCode: string | null = existingOffer?.offerCode ? String(existingOffer.offerCode) : null;
  let discountNodeId: string | null = existingOffer?.shopifyDiscountNodeId
    ? String(existingOffer.shopifyDiscountNodeId)
    : null;
  let offerCreateError: string | null = null;

  if (!offerCode && discountPercent > 0) {
    try {
      const accessToken = await getOfflineAccessToken(params.shop);
      const customerGid = await findCustomerGidByEmail(params.shop, accessToken, checkout.email);

      for (let i = 0; i < 3; i++) {
        const candidate = makeUniqueCode({
          customerName: checkout.customerName,
          percent: discountPercent,
          prefix: playbook.couponPrefix,
        });

        const created = await createDiscountCodeBasic({
          shop: params.shop,
          accessToken,
          code: candidate,
          percent: discountPercent,
          startsAt: new Date().toISOString(),
          endsAt: hoursFromNowIso(playbook.couponValidityHours),
          customerGid,
        });

        if (created.userErrors?.length) {
          const msg = created.userErrors.map((e) => String(e?.message ?? "")).join(" | ");
          if (msg.toLowerCase().includes("code") && msg.toLowerCase().includes("taken")) continue;
          throw new Error(msg);
        }

        offerCode = created.createdCode ?? candidate;
        discountNodeId = created.nodeId;
        break;
      }

      if (!offerCode) offerCreateError = "Could not generate a unique Shopify discount code after retries.";
    } catch (e: any) {
      offerCreateError = String(e?.message ?? e);
      offerCode = null;
      discountNodeId = null;
    }
  }

  const discountLink = offerCode && recoveryUrl ? appendDiscountParam(recoveryUrl, offerCode) : recoveryUrl;

  const smsFrom = String(process.env.VAPI_SMS_FROM_NUMBER ?? "").trim(); // E.164
  const smsEnabled = Boolean(playbook.followupSmsEnabled) && Boolean(smsFrom) && Boolean(discountLink);
  const tools = smsEnabled ? [{ type: "sms", metadata: { from: smsFrom } }] : undefined;

  const promptMode = pickPromptMode((settings as any)?.promptMode ?? "append");
  const merchantPrompt = String((settings as any)?.userPrompt ?? "");

  const systemPrompt = buildSystemPrompt({
    merchantPrompt,
    promptMode,
    attemptNumber,
    previousMemory,
    smsEnabled,
    offer: {
      checkoutLink: discountLink ?? null,
      offerCode: offerCode ?? null,
      discountPercent: offerCode ? discountPercent : null,
      couponValidityHours: playbook.couponValidityHours,
    },
    checkout: {
      checkoutId: String(checkout.checkoutId),
      customerName: checkout.customerName,
      email: checkout.email,
      phone: checkout.phone,
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
            customerName: checkout.customerName,
            email: checkout.email,
            phone: checkout.phone,
            value: checkout.value,
            currency: checkout.currency,
            itemsJson: checkout.itemsJson,
          },
          playbook,
        })
      : null;

  const messages: Array<{ role: "system" | "user"; content: string }> = [{ role: "system", content: systemPrompt }];
  if (factsBlock) messages.push({ role: "user", content: factsBlock });

  if (smsEnabled && discountLink) {
    const smsText = buildSmsText({
      checkoutLink: discountLink,
      offerCode,
      discountPercent: offerCode ? discountPercent : null,
      couponValidityHours: playbook.couponValidityHours,
    });
    messages.push({ role: "user", content: `If you decide to send an SMS, use this exact message:\n${smsText}` });
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
      checkoutLink: recoveryUrl,
      discountLink,
      offerCode,
      discountPercent: offerCode ? discountPercent : null,
      couponValidityHours: playbook.couponValidityHours,
      shopifyDiscountNodeId: discountNodeId,
      offerCreateError,
      generatedAt: new Date().toISOString(),
      smsEnabled,
      smsFrom: smsEnabled ? smsFrom : null,
    },
  });

  // Enforce E.164 BEFORE calling Vapi (fixes INVALID_PHONE_NUMBER)
  const customerNumber = normalizePhoneE164((job as any).phone);
  if (!customerNumber) {
    await db.callJob.update({
      where: { id: job.id },
      data: { status: "FAILED", outcome: `INVALID_PHONE_E164: ${String((job as any).phone ?? "")}`, analysisJson: nextAnalysisJson },
    });
    throw new Error(`Invalid customer phone (E.164 required): ${String((job as any).phone ?? "")}`);
  }

  await db.callJob.update({
    where: { id: job.id },
    data: { status: "CALLING", provider: "vapi", outcome: null, analysisJson: nextAnalysisJson },
  });

  const webhookUrl = VAPI_SERVER_URL.replace(/\/$/, "");

  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VAPI_API_KEY}`,
      Accept: "application/json",
    },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      assistantId: VAPI_ASSISTANT_ID,

      customer: {
        number: customerNumber,
        name: checkout.customerName ?? undefined,
      },

      assistant: {
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages,
          ...(tools ? { tools } : {}),
        },

        serverUrl: webhookUrl,
        serverMessages: [
          "status-update",
          "end-of-call-report",
          'transcript[transcriptType="final"]',
          "tool-calls",
        ],

        metadata: {
          shop: params.shop,
          callJobId: job.id,
          checkoutId: job.checkoutId,
        },
      },

      metadata: {
        shop: params.shop,
        callJobId: job.id,
        checkoutId: job.checkoutId,
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