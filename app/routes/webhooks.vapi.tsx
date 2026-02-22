// app/routes/webhooks.vapi.ts
import type { ActionFunctionArgs } from "react-router";
import { Buffer } from "node:buffer";
import db from "../db.server";
import { applyBillingForCall } from "../lib/billing.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function pickMessage(payload: any) {
  // Vapi docs show { message: { type, ... } }, but keep compatibility with flatter payloads
  return payload?.message ?? payload ?? {};
}

function safeStr(v: any, max = 4000) {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function csvFromTags(tags: any): string | null {
  if (!Array.isArray(tags)) return null;
  const clean = tags
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 30);
  return clean.length ? clean.join(",") : null;
}

// --- NEW: robust JSON extraction without breaking anything else ---
function stripCodeFences(s: string) {
  const t = safeStr(s, 20000).trim();
  if (!t) return "";
  if (t.startsWith("```")) {
    return t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return t;
}

function tryParseJsonObject(text: string): any | null {
  const raw = stripCodeFences(text);
  if (!raw) return null;

  // 1) direct parse
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}

  // 2) attempt extract first {...} block
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const chunk = raw.slice(start, end + 1);
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  return null;
}

function clamp01(n: any) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeDisposition(v: any) {
  const s = String(v ?? "").trim().toLowerCase();
  if (
    s === "interested" ||
    s === "needs_support" ||
    s === "call_back_later" ||
    s === "not_interested" ||
    s === "wrong_number" ||
    s === "unknown"
  )
    return s;
  return "unknown";
}

function secondsBetweenIso(start?: any, end?: any) {
  if (!start || !end) return 0;
  const s = new Date(String(start)).getTime();
  const e = new Date(String(end)).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  return Math.max(0, Math.floor((e - s) / 1000));
}

function extractConnectedSeconds(msg: any, call: any, artifact: any) {
  const durationSeconds = Number(
    msg?.durationSeconds ?? msg?.duration_seconds ?? call?.durationSeconds ?? call?.duration_seconds ?? NaN
  );

  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return Math.floor(durationSeconds);
  }

  const startedAt =
    msg?.startedAt ?? msg?.startAt ?? call?.startedAt ?? call?.startAt ?? artifact?.startedAt ?? artifact?.startAt ?? null;

  const endedAt =
    msg?.endedAt ?? msg?.endAt ?? call?.endedAt ?? call?.endAt ?? artifact?.endedAt ?? artifact?.endAt ?? null;

  return secondsBetweenIso(startedAt, endedAt);
}

function detectVoicemail(endedReason: string, msg: any, call: any, artifact: any) {
  const r = String(endedReason ?? "").toLowerCase();
  if (r.includes("voicemail") || r.includes("machine")) return true;
  if (typeof msg?.analysis?.voicemail === "boolean") return msg.analysis.voicemail;
  if (typeof call?.voicemail === "boolean") return call.voicemail;
  if (typeof artifact?.voicemail === "boolean") return artifact.voicemail;
  return false;
}

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
  const next = { ...(base && typeof base === "object" ? base : {}), ...(patch && typeof patch === "object" ? patch : {}) };
  return JSON.stringify(next);
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
  const validity = Math.max(1, Math.min(168, Math.floor(Number(args.couponValidityHours || 24))));

  if (link && code && pct) {
    return `Finish your checkout: ${link}\nOffer: ${pct} off\nCode: ${code}\nValid: ${validity}h`;
  }
  return link ? `Finish your checkout: ${link}` : `Finish your checkout using the link from the call.`;
}

async function analyzeCallWithOpenAI(args: {
  transcript: string;
  endedReason?: string | null;
  shop: string;
  checkoutId: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const input = `
You are analyzing a phone call between a merchant AI agent and a customer who abandoned checkout.

Return STRICT JSON with exactly these keys:
{
  "answered": boolean,
  "sentiment": "positive" | "neutral" | "negative",
  "disposition": "interested" | "needs_support" | "call_back_later" | "not_interested" | "wrong_number" | "unknown",
  "tags": string[],
  "shortSummary": string,
  "reason": string,
  "nextAction": string,
  "followUp": string,
  "buyProbability": number,
  "churnProbability": number,
  "confidence": number
}

Rules:
- answered: true only if there is real engagement (not voicemail/no-answer/busy).
- tags must be short lowercase tokens (e.g. "price", "shipping", "payment", "timing", "trust", "not_interested", "wrong_number", "needs_support", "coupon_request", "call_back_later").
- shortSummary: one sentence, plain English.
- reason: 1-2 sentences, factual.
- nextAction: ONE concrete step the merchant should do next.
- followUp: text the merchant can send (SMS/email) in a friendly tone.
- buyProbability, churnProbability, confidence: 0..1.

Context:
- shop: ${args.shop}
- checkoutId: ${args.checkoutId}
- endedReason: ${args.endedReason ?? "-"}
Transcript:
${args.transcript}
`.trim();

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input,
      temperature: 0.15,
      max_output_tokens: 550,
    }),
  });

  if (!r.ok) return null;

  const json = await r.json().catch(() => null);
  if (!json) return null;

  const text =
    json?.output_text ??
    json?.output?.[0]?.content?.[0]?.text ??
    json?.output?.[0]?.content?.[0]?.value ??
    "";

  const raw = safeStr(text, 8000).trim();
  if (!raw) return null;

  const parsed = tryParseJsonObject(raw);
  if (!parsed) return { raw };

  const cleaned = {
    answered: Boolean((parsed as any).answered),
    sentiment: String((parsed as any).sentiment ?? "neutral").toLowerCase(),
    disposition: normalizeDisposition((parsed as any).disposition),
    tags: Array.isArray((parsed as any).tags) ? (parsed as any).tags : [],
    shortSummary: safeStr((parsed as any).shortSummary ?? "", 400),
    reason: safeStr((parsed as any).reason ?? "", 2000),
    nextAction: safeStr((parsed as any).nextAction ?? "", 500),
    followUp: safeStr((parsed as any).followUp ?? "", 1200),
    buyProbability: clamp01((parsed as any).buyProbability),
    churnProbability: clamp01((parsed as any).churnProbability),
    confidence: clamp01((parsed as any).confidence),
  };

  if (cleaned.sentiment !== "positive" && cleaned.sentiment !== "neutral" && cleaned.sentiment !== "negative") {
    cleaned.sentiment = "neutral";
  }

  return cleaned;
}

// =========================
// TOOL-CALLS (deterministic SMS via server)
// =========================

function extractToolCallList(msg: any): any[] {
  if (Array.isArray(msg?.toolCallList)) return msg.toolCallList;
  if (Array.isArray(msg?.toolWithToolCallList)) {
    return msg.toolWithToolCallList.map((x: any) => x?.toolCall).filter(Boolean);
  }
  if (Array.isArray(msg?.toolCalls)) return msg.toolCalls;
  return [];
}

async function sendTwilioSms(args: {
  to: string;
  from?: string;
  body: string;
  messagingServiceSid?: string;
}) {
  const sid = requiredEnv("TWILIO_ACCOUNT_SID");
  const token = requiredEnv("TWILIO_AUTH_TOKEN");

  const form = new URLSearchParams();
  form.set("To", args.to);
  form.set("Body", args.body);

  if (args.messagingServiceSid) {
    form.set("MessagingServiceSid", args.messagingServiceSid);
  } else {
    const from = String(args.from ?? "").trim();
    if (!from) throw new Error("Missing SMS sender. Set VAPI_SMS_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID.");
    form.set("From", from);
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep raw
  }

  if (!res.ok) {
    const msg = json?.message || text || `Twilio HTTP ${res.status}`;
    throw new Error(msg);
  }

  return { sid: json?.sid ?? null, raw: json ?? text };
}

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? "";
  if (!process.env.VAPI_WEBHOOK_SECRET || secret !== process.env.VAPI_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return new Response("Bad Request", { status: 400 });

  const msg = pickMessage(payload);

  const messageType = String(msg?.type ?? msg?.messageType ?? msg?.event ?? "");
  const call = msg?.call ?? payload?.call ?? null;

  const metadata = (call?.metadata ?? msg?.metadata ?? payload?.metadata ?? payload?.assistant?.metadata ?? {}) as any;
  const shop = String(metadata?.shop ?? "").trim();
  const callJobId = String(metadata?.callJobId ?? "").trim();
  const checkoutIdMeta = String(metadata?.checkoutId ?? "").trim();

  if (!shop || !callJobId) {
    return new Response("OK", { status: 200 });
  }

  // status updates (optional)
  if (messageType === "status-update") {
    const status = String(msg?.status ?? "").toLowerCase();
    const newStatus =
      status === "in-progress" || status === "connected"
        ? "CALLING"
        : status === "ended"
          ? "COMPLETED"
          : null;

    await db.callJob.updateMany({
      where: { id: callJobId, shop },
      data: {
        status: (newStatus as any) ?? undefined,
        outcome: safeStr(`VAPI_STATUS: ${status}`, 2000),
      },
    });

    return new Response("OK", { status: 200 });
  }

  // final transcript events
  if (messageType.startsWith("transcript")) {
    const transcriptType = String(msg?.transcriptType ?? "");
    const transcript = safeStr(msg?.transcript ?? "", 20000);

    const isFinal = transcriptType === "final" || messageType.includes('transcriptType="final"');

    if (isFinal && transcript) {
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          transcript,
          outcome: safeStr("VAPI_TRANSCRIPT_FINAL_RECEIVED", 2000),
        },
      });
    }

    return new Response("OK", { status: 200 });
  }

  // tool-calls (server-side tools)
  if (messageType === "tool-calls") {
    const toolCalls = extractToolCallList(msg);

    const callObj = msg?.call ?? call ?? payload?.call ?? null;
    const to = String(callObj?.customer?.number ?? "").trim(); // deterministic recipient

    const job = await db.callJob.findFirst({
      where: { id: callJobId, shop },
      select: { analysisJson: true },
    });

    const parsed = safeJsonParse(job?.analysisJson) || {};
    const offer = parsed?.offer ?? null;

    const checkoutLink: string | null = offer?.discountLink ?? offer?.checkoutLink ?? null;
    const offerCode: string | null = offer?.offerCode ?? null;
    const discountPercent: number | null = offer?.discountPercent ?? null;
    const couponValidityHours: number = Number(offer?.couponValidityHours ?? 24);

    const body = buildSmsText({
      checkoutLink,
      offerCode,
      discountPercent,
      couponValidityHours,
    });

    const from = String(process.env.VAPI_SMS_FROM_NUMBER ?? "").trim(); // optional if using MessagingServiceSid
    const messagingServiceSid = String(process.env.TWILIO_MESSAGING_SERVICE_SID ?? "").trim() || undefined;

    const results: Array<{ toolCallId: string; result: any }> = [];

    for (const tc of toolCalls) {
      const toolCallId = String(tc?.id ?? "").trim();
      const name = String(tc?.name ?? tc?.function?.name ?? "").trim();

      if (!toolCallId) continue;

      // Accept only your deterministic tool name
      if (name !== "send_checkout_sms") {
        results.push({ toolCallId, result: { success: false, errorCode: "UNKNOWN_TOOL" } });
        continue;
      }

      if (!to) {
        results.push({ toolCallId, result: { success: false, errorCode: "MISSING_TO", message: "Missing call customer number" } });
        continue;
      }

      try {
        const sent = await sendTwilioSms({
          to,
          from,
          body,
          messagingServiceSid,
        });

        const nextJson = mergeAnalysisJson(job?.analysisJson ?? null, {
          sms: { to, from: messagingServiceSid ? null : from, messagingServiceSid: messagingServiceSid ?? null, sid: sent.sid, sentAt: new Date().toISOString() },
        });

        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: {
            outcome: safeStr(`SMS_SENT: to=${to} sid=${String(sent.sid ?? "-")}`, 2000),
            analysisJson: safeStr(nextJson, 8000),
          },
        });

        results.push({ toolCallId, result: { success: true, sid: sent.sid } });
      } catch (e: any) {
        const msgErr = String(e?.message ?? e);
        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: { outcome: safeStr(`SMS_ERROR: ${msgErr}`, 2000) },
        });
        results.push({ toolCallId, result: { success: false, errorCode: "TWILIO_API_ERROR", message: msgErr } });
      }
    }

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // end-of-call-report (main value)
  if (messageType === "end-of-call-report") {
    const endedReason = safeStr(msg?.endedReason ?? "", 200);
    const artifact = msg?.artifact ?? {};
    const transcript = safeStr(artifact?.transcript ?? "", 20000);

    const recordingUrl =
      artifact?.recording?.url ?? artifact?.recording?.downloadUrl ?? artifact?.recording?.recordingUrl ?? null;

    await db.callJob.updateMany({
      where: { id: callJobId, shop },
      data: {
        status: "COMPLETED",
        endedReason: endedReason || null,
        transcript: transcript || null,
        recordingUrl: recordingUrl ? safeStr(recordingUrl, 2000) : null,
        outcome: safeStr("VAPI_END_OF_CALL_REPORT", 2000),
      },
    });

    const analysis = transcript
      ? await analyzeCallWithOpenAI({
          transcript,
          endedReason: endedReason || null,
          shop,
          checkoutId: checkoutIdMeta || "",
        })
      : null;

    let answeredForBilling = false;

    if (analysis) {
      const sentiment = safeStr((analysis as any)?.sentiment ?? "", 30) || null;
      const tagsCsv = csvFromTags((analysis as any)?.tags) ?? null;

      const reason = safeStr((analysis as any)?.reason ?? (analysis as any)?.raw ?? "", 2000) || null;
      const nextAction = safeStr((analysis as any)?.nextAction ?? "", 500) || null;
      const followUp = safeStr((analysis as any)?.followUp ?? "", 1200) || null;

      const shortSummary = safeStr((analysis as any)?.shortSummary ?? "", 400);
      const answered = (analysis as any)?.answered;
      const disposition = safeStr((analysis as any)?.disposition ?? "unknown", 30);
      const buyProbability = (analysis as any)?.buyProbability;

      answeredForBilling = answered === true;

      const existing = await db.callJob.findFirst({
        where: { id: callJobId, shop },
        select: { analysisJson: true },
      });

      const nextJson = mergeAnalysisJson(existing?.analysisJson ?? null, analysis);

      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          sentiment,
          tagsCsv,
          reason,
          nextAction,
          followUp,
          analysisJson: safeStr(nextJson, 8000),
          outcome: safeStr(
            `${sentiment ?? "unknown"} | ${tagsCsv ?? "-"} | ${shortSummary || reason || "no-reason"} | ${
              answered === true ? "answered" : answered === false ? "no_answer" : "unknown"
            } | ${disposition} | buy=${Math.round(clamp01(buyProbability) * 100)}%`,
            2000
          ),
        },
      });
    }

    // BILLING (rounded minutes happens inside applyBillingForCall)
    try {
      const connectedSeconds = extractConnectedSeconds(msg, call, artifact);
      const voicemail = detectVoicemail(endedReason, msg, call, artifact);

      await applyBillingForCall({
        shop,
        callJobId,
        connectedSeconds,
        answered: answeredForBilling,
        voicemail,
      });
    } catch (e: any) {
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: { outcome: safeStr(`BILLING_ERROR: ${e?.message ?? String(e)}`, 2000) },
      });
    }

    return new Response("OK", { status: 200 });
  }

  // default: store event type for debugging
  await db.callJob.updateMany({
    where: { id: callJobId, shop },
    data: {
      outcome: safeStr(`VAPI_EVENT: ${messageType || "unknown"}`, 2000),
    },
  });

  return new Response("OK", { status: 200 });
}