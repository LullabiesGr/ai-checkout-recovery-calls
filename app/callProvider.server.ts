// app/callProvider.server.ts
import db from "./db.server";

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
  if (tone === "friendly") return "Warm, helpful, human. Short sentences. Light humor allowed if customer engages.";
  if (tone === "premium") return "Calm, confident, concierge-style. Precise language. No slang. Respectful pacing.";
  if (tone === "urgent") return "Direct and efficient. Time-boxed. Clear next step. No rambling.";
  return "Neutral, professional, helpful.";
}

function goalGuidance(goal: Goal) {
  if (goal === "qualify_and_follow_up")
    return "Goal: qualify intent fast, then secure permission for follow-up (email/SMS) if they won't complete now.";
  if (goal === "support_only")
    return "Goal: support only. Do not offer discounts proactively unless asked. Focus on help, trust, and logistics.";
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
  disposition: string | null;

  summary_clean: string | null;
  summary: string | null;

  objections_text: string | null;
  key_quotes_text: string | null;

  best_next_action: string | null;
  next_best_action: string | null;
  follow_up_message: string | null;

  discount_percent: number | null;
  ended_reason: string | null;
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

async function readPreviousCallMemory(params: {
  shop: string;
  checkoutId: string;
  currentCallJobId: string;
}): Promise<string | null> {
  const { shop, checkoutId, currentCallJobId } = params;

  // Prefer vapi_call_summaries (structured, already AI-processed)
  const rows = await (db as any).$queryRaw<PrevSummaryRow[]>`
    select
      received_at,
      answered,
      voicemail,
      sentiment,
      call_outcome,
      disposition,
      summary_clean,
      summary,
      objections_text,
      key_quotes_text,
      best_next_action,
      next_best_action,
      follow_up_message,
      discount_percent,
      ended_reason
    from public."vapi_call_summaries"
    where shop = ${shop}
      and checkout_id = ${checkoutId}
      and (call_job_id is null or call_job_id <> ${currentCallJobId})
    order by received_at desc nulls last
    limit 2
  `;

  const picked = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (picked.length) {
    const parts = picked.map((r, i) => {
      const label = i === 0 ? "LAST CALL" : "PREVIOUS CALL";
      const outcome = cleanLine(r.call_outcome || r.disposition || "unknown");
      const ans = r.answered == null ? "unknown" : r.answered ? "yes" : "no";
      const vm = r.voicemail == null ? "unknown" : r.voicemail ? "yes" : "no";
      const sent = cleanLine(r.sentiment || "unknown");
      const ended = cleanLine(r.ended_reason || "");
      const sum = cleanLine(r.summary_clean || r.summary || "");
      const obj = cleanLine(r.objections_text || "");
      const quotes = cleanLine(r.key_quotes_text || "");
      const next = cleanLine(r.best_next_action || r.next_best_action || "");
      const fu = cleanLine(r.follow_up_message || "");
      const disc = r.discount_percent == null ? "" : `discount_percent=${Number(r.discount_percent)}%`;

      const lines: string[] = [];
      lines.push(
        `[${label}] outcome=${outcome}; answered=${ans}; voicemail=${vm}; sentiment=${sent}${
          disc ? "; " + disc : ""
        }${ended ? "; ended_reason=" + ended : ""}`
      );
      if (sum) lines.push(`summary: ${trunc(sum, 500)}`);
      if (obj) lines.push(`objections: ${trunc(obj, 350)}`);
      if (quotes) lines.push(`key_quotes: ${trunc(quotes, 300)}`);
      if (next) lines.push(`next_action: ${trunc(next, 220)}`);
      if (fu) lines.push(`follow_up_message: ${trunc(fu, 220)}`);

      return lines.join("\n");
    });

    return trunc(parts.join("\n\n"), 1400);
  }


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
// Prompt builder
// =========================

function buildSystemPrompt(args: {
  merchantPrompt?: string | null;
  promptMode?: PromptMode;
  attemptNumber?: number;
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
  const { merchantPrompt, checkout, playbook } = args;

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
- If a follow-up was promised (call later / send link / discount), acknowledge it first.
- If memory is unclear, ask one confirmation question max, then proceed.
`.trim()
    : "";

  const base = `
You are the merchant's AI phone agent. Your job: recover an abandoned checkout politely and efficiently.
${attemptN > 1 ? `This is a follow-up attempt (#${attemptN}).` : "This is the first attempt."}

Hard rules:
- Confirm identity. Ask if it's a good time.
- Keep it short. Target a maximum call length of ~${playbook.maxCallSeconds} seconds.
- Do not be pushy. If not interested, end politely and mark as not interested.
- Never invent policies, discounts, or shipping offers beyond the rules below.
${memoryBlock ? `\n\n${memoryBlock}\n` : ""}

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

Context:
- Checkout ID: ${checkout.checkoutId}
- Customer name: ${checkout.customerName ?? "-"}
- Email: ${checkout.email ?? "-"}
- Cart total: ${checkout.value} ${checkout.currency}
- Cart items:
${cartText}
`.trim();

  const mode = pickPromptMode(args.promptMode ?? "append");
  const merchant = (merchantPrompt ?? "").trim();

  if (mode === "default_only") return base;

  if (mode === "replace") {
    // system = only merchant prompt (fallback to base if empty so calls still work)
    return merchant ? merchant : base;
  }

  // append (current behavior)
  if (!merchant) return base;
  return `${base}\n\nMerchant instructions (must follow):\n${merchant}`.trim();
}

export async function startVapiCallForJob(params: { shop: string; callJobId: string }) {
  const VAPI_API_KEY = requiredEnv("VAPI_API_KEY");
  const VAPI_ASSISTANT_ID = requiredEnv("VAPI_ASSISTANT_ID"); // yours (global)
  const VAPI_PHONE_NUMBER_ID = requiredEnv("VAPI_PHONE_NUMBER_ID"); // yours (global)
  const VAPI_SERVER_URL = requiredEnv("VAPI_SERVER_URL"); // your webhook URL

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

  // attempt number: how many CallJobs already exist for this checkout (excluding current)
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

    const promptMode = pickPromptMode((settings as any)?.promptMode ?? "append");
  const merchantPrompt = String((settings as any)?.userPrompt ?? "");

  const systemPrompt = buildSystemPrompt({
    merchantPrompt,
    promptMode,
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

  messages.push({
    role: "user",
    content:
      attemptNumber >= 2
        ? "Follow-up call. Reference the previous memory if relevant. Keep it short and move to a concrete next step."
        : "Start the call now. Greet the customer, mention they almost completed checkout, and ask if they want help finishing the order.",
  });

  // runner already increments attempts; keep this idempotent here.
  await db.callJob.update({
    where: { id: job.id },
    data: { status: "CALLING", provider: "vapi", outcome: null },
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
      number: (job as any).phone,
      name: checkout.customerName ?? undefined,
    },

    assistant: {
      model: {
        provider: "openai",
        model: "gpt-4o-mini",
        messages, // ✅ use computed messages (includes factsBlock when replace)
      },

      serverUrl: webhookUrl,
      serverMessages: ["status-update", "end-of-call-report", 'transcript[transcriptType="final"]'],

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