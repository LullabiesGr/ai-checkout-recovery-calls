// app/routes/webhooks.vapi.ts
import type { ActionFunctionArgs } from "react-router";
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
    msg?.durationSeconds ??
      msg?.duration_seconds ??
      call?.durationSeconds ??
      call?.duration_seconds ??
      NaN
  );

  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return Math.floor(durationSeconds);
  }

  const startedAt =
    msg?.startedAt ??
    msg?.startAt ??
    call?.startedAt ??
    call?.startAt ??
    artifact?.startedAt ??
    artifact?.startAt ??
    null;

  const endedAt =
    msg?.endedAt ??
    msg?.endAt ??
    call?.endedAt ??
    call?.endAt ??
    artifact?.endedAt ??
    artifact?.endAt ??
    null;

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

/* =========================================================
   NEW: deterministic Vapi tool-calls -> Twilio SMS (server-side)
   - Ignore any LLM "to". Always use message.call.customer.number.
   - Must return {"results":[{name, toolCallId, result|error}]} for tool-calls.
   ========================================================= */

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toBase64Utf8(s: string) {
  // Node
  // eslint-disable-next-line no-undef
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  // Web
  // @ts-ignore
  if (typeof btoa === "function") return btoa(s);
  throw new Error("No base64 encoder available");
}

async function twilioSendSms(args: { to: string; body: string }) {
  const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
  const authToken = requiredEnv("TWILIO_AUTH_TOKEN");
  const from = requiredEnv("TWILIO_SMS_FROM"); // e.g. +1912...

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams();
  params.set("To", args.to);
  params.set("From", from);
  params.set("Body", args.body);

  const auth = toBase64Utf8(`${accountSid}:${authToken}`);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await r.json().catch(() => null);

  if (!r.ok) {
    const msg = safeStr(data?.message ?? data?.error_message ?? r.statusText, 500);
    throw new Error(`Twilio SMS failed (${r.status}): ${msg}`);
  }

  return {
    sid: safeStr(data?.sid ?? "", 80),
    status: safeStr(data?.status ?? "", 40),
  };
}

function extractFromRawCheckout(raw: any): string | null {
  const obj = typeof raw === "string" ? tryParseJsonObject(raw) ?? null : raw;
  if (!obj || typeof obj !== "object") return null;

  const candidates = [
    obj?.abandoned_checkout_url,
    obj?.abandonedCheckoutUrl,
    obj?.recovery_url,
    obj?.recoveryUrl,
    obj?.checkout_url,
    obj?.checkoutUrl,
    obj?.web_url,
    obj?.webUrl,
  ];

  for (const c of candidates) {
    const s = typeof c === "string" ? c.trim() : "";
    if (s.startsWith("http")) return s;
  }

  return null;
}

function extractCheckoutLinkFromAssistantConfig(payload: any): string | null {
  // Fallback: scrape link from assistant prompt/messages (works even if DB lacks URL)
  const blobs: string[] = [];

  const msg = pickMessage(payload);
  const call = msg?.call ?? payload?.call ?? null;

  const sources = [
    payload?.assistant?.model?.messages,
    call?.assistant?.model?.messages,
    msg?.assistant?.model?.messages,
    msg?.messages,
    msg?.messagesOpenAIFormatted,
  ];

  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (const m of src) {
      const t = safeStr(m?.content ?? m?.message ?? "", 20000).trim();
      if (t) blobs.push(t);
    }
  }

  const joined = blobs.join("\n");

  // Strong patterns first
  const m1 = joined.match(/CHECKOUT_LINK:\s*(https?:\/\/\S+)/i);
  if (m1?.[1]) return m1[1].trim();

  const m2 = joined.match(/Finish your checkout:\s*(https?:\/\/\S+)/i);
  if (m2?.[1]) return m2[1].trim();

  // Generic URL scan (prefer /recover links)
  const urls = joined.match(/https?:\/\/[^\s"')]+/g) ?? [];
  const recover = urls.find((u) => u.includes("/recover")) ?? null;
  return recover ?? urls[0] ?? null;
}

function extractOfferCodeFromAssistantConfig(payload: any): string | null {
  const msg = pickMessage(payload);
  const call = msg?.call ?? payload?.call ?? null;

  const blobs: string[] = [];
  const sources = [payload?.assistant?.model?.messages, call?.assistant?.model?.messages, msg?.assistant?.model?.messages];
  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (const m of src) {
      const t = safeStr(m?.content ?? m?.message ?? "", 20000).trim();
      if (t) blobs.push(t);
    }
  }
  const joined = blobs.join("\n");

  const m = joined.match(/OFFER_CODE:\s*([A-Za-z0-9_-]+)/i);
  if (!m?.[1]) return null;

  const code = m[1].trim();
  if (!code || code === "-" || code.toLowerCase() === "null") return null;
  return code;
}

function buildCheckoutSmsBody(args: { checkoutLink: string | null; offerCode: string | null }) {
  const parts: string[] = [];

  if (args.checkoutLink) parts.push(`Finish your checkout: ${args.checkoutLink}`);
  else parts.push(`Finish your checkout from the store link.`);

  if (args.offerCode) parts.push(`Discount code: ${args.offerCode}`);

  const out = parts.join("\n").trim();
  return out.length > 1200 ? out.slice(0, 1200) : out;
}

function normalizeToolCalls(msg: any) {
  // Vapi docs: toolCallList OR toolWithToolCallList[].toolCall 
  const list: Array<{ id: string; name: string; parameters?: any }> = [];

  if (Array.isArray(msg?.toolCallList)) {
    for (const tc of msg.toolCallList) {
      if (!tc) continue;
      list.push({
        id: safeStr(tc?.id ?? "", 120),
        name: safeStr(tc?.name ?? "", 120),
        parameters: tc?.parameters ?? {},
      });
    }
    return list.filter((x) => x.id && x.name);
  }

  if (Array.isArray(msg?.toolWithToolCallList)) {
    for (const tw of msg.toolWithToolCallList) {
      const tc = tw?.toolCall ?? null;
      if (!tc) continue;
      list.push({
        id: safeStr(tc?.id ?? "", 120),
        name: safeStr(tw?.name ?? tc?.name ?? "", 120),
        parameters: tc?.parameters ?? {},
      });
    }
    return list.filter((x) => x.id && x.name);
  }

  return list;
}

async function analyzeCallWithOpenAI(args: {
  transcript: string;
  endedReason?: string | null;
  shop: string;
  checkoutId: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // UPGRADE: still JSON, same flow, just richer keys
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

  // OpenAI Responses API (unchanged)
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

  // Robust parse
  const parsed = tryParseJsonObject(raw);
  if (!parsed) return { raw };

  // Normalize + clamp without changing callers
  const cleaned: any = {
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

  // fallback sentiment to allowed set
  if (cleaned.sentiment !== "positive" && cleaned.sentiment !== "neutral" && cleaned.sentiment !== "negative") {
    cleaned.sentiment = "neutral";
  }

  return cleaned;
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

  /* =========================
     NEW: tool-calls handler
     ========================= */
  if (messageType === "tool-calls") {
    const toolCalls = normalizeToolCalls(msg);

    // deterministic "to": ALWAYS from call.customer.number (ignore model args)
    const to =
      String(call?.customer?.number ?? "").trim() ||
      String(msg?.customer?.number ?? "").trim() ||
      String(payload?.customer?.number ?? "").trim() ||
      "";

    const results: any[] = [];

    for (const tc of toolCalls) {
      const name = tc.name;
      const toolCallId = tc.id;

      if (name !== "send_checkout_sms") {
        results.push({
          name,
          toolCallId,
          result: JSON.stringify({ ok: true, skipped: true }),
        });
        continue;
      }

      try {
        if (!to) throw new Error("Missing customer number (call.customer.number).");

        // Prefer DB extraction, fallback to assistant prompt scrape
        let checkoutLink: string | null = null;
        let offerCode: string | null = null;

        // DB: callJob -> checkout -> raw url
        const job = await db.callJob.findFirst({
          where: { id: callJobId, shop },
          select: { checkoutId: true },
        });

        const checkoutId = String(job?.checkoutId ?? checkoutIdMeta ?? "").trim();

        if (checkoutId) {
          const co = await db.checkout.findFirst({
            where: { shop, checkoutId },
            select: { raw: true },
          });

          checkoutLink = extractFromRawCheckout((co as any)?.raw) ?? null;
        }

        // Fallback: parse from assistant config/messages
        if (!checkoutLink) checkoutLink = extractCheckoutLinkFromAssistantConfig(payload);
        offerCode = extractOfferCodeFromAssistantConfig(payload);

        const body = buildCheckoutSmsBody({ checkoutLink, offerCode });

        const tw = await twilioSendSms({ to, body });

        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: {
            outcome: safeStr(`SMS_SENT sid=${tw.sid} to=${to}`, 2000),
          },
        });

        results.push({
          name,
          toolCallId,
          result: JSON.stringify({
            ok: true,
            sid: tw.sid,
            to,
          }),
        });
      } catch (e: any) {
        const err = safeStr(e?.message ?? String(e), 800);
        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: { outcome: safeStr(`SMS_ERROR: ${err}`, 2000) },
        });

        results.push({
          name,
          toolCallId,
          error: err,
        });
      }
    }

    // This exact shape is REQUIRED by Vapi for tool-calls responses :contentReference[oaicite:2]{index=2}
    return jsonResponse({ results });
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

      // keep your old fields, plus richer JSON inside analysisJson
      const reason = safeStr((analysis as any)?.reason ?? (analysis as any)?.raw ?? "", 2000) || null;
      const nextAction = safeStr((analysis as any)?.nextAction ?? "", 500) || null;
      const followUp = safeStr((analysis as any)?.followUp ?? "", 1200) || null;

      const shortSummary = safeStr((analysis as any)?.shortSummary ?? "", 400);
      const answered = (analysis as any)?.answered;
      const disposition = safeStr((analysis as any)?.disposition ?? "unknown", 30);
      const buyProbability = (analysis as any)?.buyProbability;

      answeredForBilling = answered === true;

      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: {
          sentiment,
          tagsCsv,
          reason,
          nextAction,
          followUp,
          analysisJson: safeStr(JSON.stringify(analysis), 8000),
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
      // swallow: never fail webhook
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