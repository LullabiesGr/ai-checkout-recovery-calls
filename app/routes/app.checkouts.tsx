// app/routes/app.checkouts.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

import {
  buildCartPreview,
  formatWhen,
  pickLatestJobByCheckout,
  pickRecordingUrl,
  safeStr,
  type SupabaseCallSummary,
} from "../lib/callInsights.shared";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-page": any;
      "s-section": any;
      "s-box": any;
      "s-text": any;
      "s-badge": any;
      "s-divider": any;
      "s-grid": any;
      "s-stack": any;
      "s-table": any;
      "s-table-header-row": any;
      "s-table-header": any;
      "s-table-body": any;
      "s-table-row": any;
      "s-table-cell": any;
      "s-button": any;
      "s-thumbnail": any;
      "s-spinner": any;
      "s-modal": any;
      "s-link": any;
      "s-chip": any;
    }
  }
}

/* ---------------- URL helpers (keep embedded params) ---------------- */
function safeSearch(): string {
  if (typeof window === "undefined") return "";
  const s = window.location.search || "";
  return s.startsWith("?") ? s : s ? `?${s}` : "";
}
function withSearch(path: string): string {
  const s = safeSearch();
  if (!s) return path;
  if (path.includes("?")) return path;
  return `${path}${s}`;
}

/* ---------------- Outcome normalization (strict) ---------------- */
export type NormalizedOutcome =
  | "recovered"
  | "converted"
  | "not_recovered"
  | "no_answer"
  | "voicemail"
  | "needs_followup"
  | "not_interested"
  | "other"
  | "none";

export function normalizeOutcome(outcome: string | null): NormalizedOutcome {
  const raw = safeStr(outcome).toLowerCase().trim();
  if (!raw) return "none";

  const norm = raw
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!norm) return "none";

  // Strict mapping (no substring checks)
  switch (norm) {
    case "recovered":
      return "recovered";
    case "converted":
      return "converted";

    case "not_recovered":
      return "not_recovered";
    case "notrecovered":
      return "not_recovered";
    case "no_recovery":
      return "not_recovered";

    case "no_answer":
      return "no_answer";
    case "noanswer":
      return "no_answer";
    case "not_answered":
      return "no_answer";

    case "voicemail":
      return "voicemail";
    case "left_voicemail":
      return "voicemail";
    case "voicemail_left":
      return "voicemail";

    case "needs_followup":
      return "needs_followup";
    case "needs_follow_up":
      return "needs_followup";
    case "follow_up_needed":
      return "needs_followup";
    case "followup_needed":
      return "needs_followup";
    case "followup":
      return "needs_followup";
    case "follow_up":
      return "needs_followup";

    case "not_interested":
      return "not_interested";
    case "notinterested":
      return "not_interested";
    case "no_interest":
      return "not_interested";

    default:
      return "other";
  }
}

function isRecoveredOutcome(outcome: string | null): boolean {
  const n = normalizeOutcome(outcome);
  return n === "recovered" || n === "converted";
}

/* ---------------- Tones ---------------- */
type BadgeTone = "success" | "critical" | "warning" | "info" | "neutral";

function toneForCheckoutStatus(status: string): BadgeTone {
  const s = safeStr(status).toUpperCase();
  if (s === "CONVERTED" || s === "RECOVERED") return "success";
  if (s === "ABANDONED") return "critical";
  if (s === "OPEN") return "warning";
  return "info";
}
function toneForJobStatus(status: string): BadgeTone {
  const s = safeStr(status).toUpperCase();
  if (s === "COMPLETED") return "success";
  if (s === "CALLING") return "warning";
  if (s === "QUEUED") return "warning";
  if (s === "FAILED") return "critical";
  return "info";
}
function toneForOutcome(outcome: string | null): BadgeTone {
  const n = normalizeOutcome(outcome);
  if (n === "none") return "neutral";
  if (n === "recovered" || n === "converted") return "success";
  if (n === "not_recovered" || n === "not_interested") return "critical";
  if (n === "no_answer" || n === "voicemail" || n === "needs_followup") return "warning";
  return "info";
}

function outcomeLabel(outcome: string | null): string {
  const n = normalizeOutcome(outcome);
  switch (n) {
    case "none":
      return "OUTCOME —";
    case "recovered":
      return "RECOVERED";
    case "converted":
      return "CONVERTED";
    case "not_recovered":
      return "NOT RECOVERED";
    case "not_interested":
      return "NOT INTERESTED";
    case "no_answer":
      return "NO ANSWER";
    case "voicemail":
      return "VOICEMAIL";
    case "needs_followup":
      return "NEEDS FOLLOW-UP";
    case "other":
    default: {
      const raw = safeStr(outcome).trim();
      return raw ? raw.toUpperCase() : "OUTCOME —";
    }
  }
}

/* ---------------- Types ---------------- */
type CartItemLite = {
  title?: string | null;
  name?: string | null;
  quantity?: number | string | null;
  qty?: number | string | null;
  image?: string | null;
  imageUrl?: string | null;
  thumbnail?: string | null;
  src?: string | null;
  url?: string | null;
  variantTitle?: string | null;
  sku?: string | null;
};

type Row = {
  checkoutId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  abandonedAt: string | null;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  value: number;
  currency: string;

  itemsJson: any;
  cartPreview: string | null;
  thumbUrl: string | null;
  itemsCount: number;

  // recovery fields (DB)
  recoveredAt: string | null;
  recoveredOrderId: string | null;
  recoveredAmount: number | null;

  // eligibility (computed server-side using settings.minOrderValue, fallback 0)
  eligibleAtRisk: boolean;

  callStatus: string | null;
  callOutcome: string | null;
  aiStatus: string | null;
  buyProbabilityPct: number | null;
  recordingUrl: string | null;
  logUrl: string | null;

  // from outcomes table (use them everywhere)
  nextBestAction: string | null;
  followUpMessage: string | null;
  summaryClean: string | null;

  sentiment: string | null;
  tone: string | null;
  customerIntent: string | null;
  latestStatus: string | null;
  endedReason: string | null;
  answered: boolean | null;
  voicemail: boolean | null;

  // optional discount fields (present only if columns exist)
  discountSuggest?: boolean | null;
  discountPercent?: number | null;

  latestJobId: string | null;
  latestProviderCallId: string | null;
};

type LoaderData = {
  shop: string;
  rows: Row[];
};

/* ---------------- Cart parsing helpers ---------------- */
function safeJsonParse<T = any>(v: any): T | null {
  if (v == null) return null;
  if (typeof v === "object") return v as T;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function pickThumbFromItem(it: CartItemLite): string {
  const candidates = [it.imageUrl, it.image, it.thumbnail, it.src, it.url]
    .map((x) => safeStr(x).trim())
    .filter(Boolean);
  return candidates[0] || "";
}

function toItemsArray(itemsJson: any): CartItemLite[] {
  const parsed = safeJsonParse<any>(itemsJson) ?? itemsJson;
  if (!parsed) return [];

  if (Array.isArray(parsed)) return parsed as CartItemLite[];

  const maybe =
    (Array.isArray(parsed.items) && parsed.items) ||
    (Array.isArray(parsed.lineItems) && parsed.lineItems) ||
    (Array.isArray(parsed.lines) && parsed.lines) ||
    (Array.isArray(parsed.cart?.items) && parsed.cart.items) ||
    (Array.isArray(parsed.cart?.lineItems) && parsed.cart.lineItems) ||
    null;

  return Array.isArray(maybe) ? (maybe as CartItemLite[]) : [];
}

function getThumbAndCount(itemsJson: any): { thumbUrl: string | null; count: number } {
  const items = toItemsArray(itemsJson);
  const count = items.length;
  for (const it of items) {
    const url = pickThumbFromItem(it);
    if (url) return { thumbUrl: url, count };
  }
  return { thumbUrl: null, count };
}

/* ---------------- Formatting ---------------- */
function fmtMoney(amount: number, currency: string) {
  const v = Number.isFinite(amount) ? amount : 0;
  const cur = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${cur}`;
  }
}
function pct(part: number, whole: number) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}
function tiny(v: any) {
  const s = safeStr(v).trim();
  return s ? s : "—";
}

function clip(text: string) {
  try {
    void navigator.clipboard.writeText(text);
  } catch {}
}

/* ---------------- Loader ---------------- */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // keep ensureSettings
  const settings: any = await ensureSettings(shop);
  const minOrderValue =
    typeof settings?.minOrderValue === "number"
      ? settings.minOrderValue
      : typeof settings?.min_order_value === "number"
        ? settings.min_order_value
        : 0;

  const [checkouts, jobs] = await Promise.all([
    db.checkout.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        checkoutId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        abandonedAt: true,
        customerName: true,
        phone: true,
        email: true,
        value: true,
        currency: true,
        itemsJson: true,

        // ✅ required for recovered metrics/list
        recoveredAt: true,
        recoveredOrderId: true,
        recoveredAmount: true,
      },
    }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 800,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        attempts: true,
        createdAt: true,
        providerCallId: true,
        recordingUrl: true,
      },
    }),
  ]);

  const latestJobMap = pickLatestJobByCheckout(jobs);

  const checkoutIds = checkouts.map((c) => String(c.checkoutId)).filter(Boolean);
  const callIds = checkouts
    .map((c) => {
      const j = latestJobMap.get(String(c.checkoutId)) ?? null;
      return j?.providerCallId ? String(j.providerCallId) : "";
    })
    .filter(Boolean);
  const jobIds = checkouts
    .map((c) => {
      const j = latestJobMap.get(String(c.checkoutId)) ?? null;
      return j?.id ? String(j.id) : "";
    })
    .filter(Boolean);

  function uniq(values: string[]) {
    const s = new Set(values.map((x) => x.trim()).filter(Boolean));
    return Array.from(s);
  }
  function cleanIdList(values: string[]) {
    return uniq(values).map((x) => x.replace(/[,"'()]/g, ""));
  }
  function pickNewer(a: any, b: any) {
    const ta = Date.parse(String(a?.last_received_at ?? a?.received_at ?? ""));
    const tb = Date.parse(String(b?.last_received_at ?? b?.received_at ?? ""));
    const na = Number.isFinite(ta) ? ta : 0;
    const nb = Number.isFinite(tb) ? tb : 0;
    return nb >= na ? b : a;
  }

  async function fetchSupabaseSummariesLite(opts: {
    shop: string;
    callIds?: string[];
    callJobIds?: string[];
    checkoutIds?: string[];
  }): Promise<Map<string, SupabaseCallSummary>> {
    const out = new Map<string, SupabaseCallSummary>();

    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) return out;

    const callIds = cleanIdList(opts.callIds ?? []);
    const callJobIds = cleanIdList(opts.callJobIds ?? []);
    const checkoutIds = cleanIdList(opts.checkoutIds ?? []);
    if (callIds.length === 0 && callJobIds.length === 0 && checkoutIds.length === 0) return out;

    const baseSelectFields = [
      "shop",
      "call_id",
      "call_job_id",
      "checkout_id",
      "received_at",
      "last_received_at",
      "ai_status",
      "call_outcome",
      "buy_probability",
      "recording_url",
      "stereo_recording_url",
      "log_url",
      "latest_status",
      "ended_reason",
      "answered",
      "voicemail",
      "sentiment",
      "tone",
      "customer_intent",
      "summary",
      "summary_clean",
      "next_best_action",
      "best_next_action",
      "follow_up_message",
      "key_quotes",
      "key_quotes_text",
      "objections",
      "objections_text",
      "issues_to_fix",
      "issues_to_fix_text",
      "tagcsv",
      "tags",
      "transcript",
      "end_of_call_report",
      "ai_result",
      "structured_outputs",
      "payload",
    ];

    // Try extended select for discount chip; fall back if columns don't exist.
    const extendedSelectFields = [...baseSelectFields, "discount_suggest", "discount_percent"];

    const orParts: string[] = [];
    if (callIds.length) orParts.push(`call_id.in.(${callIds.join(",")})`);
    if (callJobIds.length) orParts.push(`call_job_id.in.(${callJobIds.join(",")})`);
    if (checkoutIds.length) orParts.push(`checkout_id.in.(${checkoutIds.join(",")})`);

    function makeParams(select: string, includeShopFilter: boolean) {
      const p = new URLSearchParams();
      p.set("select", select);
      p.set("or", `(${orParts.join(",")})`);
      p.set("order", "last_received_at.desc,received_at.desc");
      if (includeShopFilter) p.set("shop", `eq.${opts.shop}`);
      return p;
    }

    async function doFetch(p: URLSearchParams) {
      const endpoint = `${url}/rest/v1/vapi_call_summaries?${p.toString()}`;
      const r = await fetch(endpoint, {
        method: "GET",
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
      });
      if (!r.ok) {
        let text = "";
        try {
          text = await r.text();
        } catch {}
        return { ok: false as const, status: r.status, text };
      }
      const data = (await r.json()) as SupabaseCallSummary[];
      return { ok: true as const, data: Array.isArray(data) ? data : [] };
    }

    async function fetchWithSelect(selectFields: string[]) {
      const select = selectFields.join(",");
      const withShop = makeParams(select, true);
      const withoutShop = makeParams(select, false);

      let res = await doFetch(withShop);
      if (res.ok && res.data.length === 0) res = await doFetch(withoutShop);
      return res;
    }

    // attempt extended select first
    let res = await fetchWithSelect(extendedSelectFields);
    if (!res.ok) {
      const msg = (res.text || "").toLowerCase();
      const looksLikeMissingColumn =
        res.status === 400 &&
        (msg.includes("discount_suggest") || msg.includes("discount_percent") || msg.includes("column") || msg.includes("does not exist"));

      if (looksLikeMissingColumn) {
        res = await fetchWithSelect(baseSelectFields);
      }
    }

    const data = res.ok ? res.data : [];

    for (const row of data || []) {
      if (!row) continue;

      const callId = (row as any).call_id ? String((row as any).call_id) : "";
      const jobId = (row as any).call_job_id ? String((row as any).call_job_id) : "";
      const coId = (row as any).checkout_id ? String((row as any).checkout_id) : "";

      if (callId) {
        const k = `call:${callId}`;
        out.set(k, out.has(k) ? (pickNewer(out.get(k) as any, row as any) as any) : row);
      }
      if (jobId) {
        const k = `job:${jobId}`;
        out.set(k, out.has(k) ? (pickNewer(out.get(k) as any, row as any) as any) : row);
      }
      if (coId) {
        const k = `co:${coId}`;
        out.set(k, out.has(k) ? (pickNewer(out.get(k) as any, row as any) as any) : row);
      }
    }

    return out;
  }

  const sbMap = await fetchSupabaseSummariesLite({
    shop,
    callIds: Array.from(new Set(callIds)),
    callJobIds: Array.from(new Set(jobIds)),
    checkoutIds: Array.from(new Set(checkoutIds)),
  });

  const rows: Row[] = checkouts.map((c) => {
    const checkoutId = String(c.checkoutId);
    const j = latestJobMap.get(checkoutId) ?? null;

    const callId = j?.providerCallId ? String(j.providerCallId) : "";
    const jobId = j?.id ? String(j.id) : "";

    const sb: SupabaseCallSummary | null =
      (callId ? (sbMap.get(`call:${callId}`) as any) : null) ||
      (jobId ? (sbMap.get(`job:${jobId}`) as any) : null) ||
      (checkoutId ? (sbMap.get(`co:${checkoutId}`) as any) : null) ||
      null;

    const buyProbabilityPct =
      typeof (sb as any)?.buy_probability === "number" && Number.isFinite((sb as any).buy_probability)
        ? Math.round((sb as any).buy_probability)
        : null;

    const recordingUrl = (pickRecordingUrl(sb) ?? (j?.recordingUrl ? String(j.recordingUrl) : null)) ?? null;

    const cartPreview = buildCartPreview(c.itemsJson ?? null);
    const { thumbUrl, count } = getThumbAndCount(c.itemsJson ?? null);

    const raRaw = (c as any).recoveredAmount;
    const recoveredAmount = raRaw == null ? null : Number(raRaw);
    const recoveredAmountSafe = Number.isFinite(recoveredAmount as any) ? (recoveredAmount as number) : null;

    const recoveredAtIso = (c as any).recoveredAt ? new Date((c as any).recoveredAt).toISOString() : null;
    const recoveredOrderId = safeStr((c as any).recoveredOrderId).trim() ? String((c as any).recoveredOrderId) : null;

    const statusUpper = safeStr(c.status).toUpperCase();
    const hasContact = !!safeStr(c.phone).trim() || !!safeStr(c.email).trim();
    const eligibleAtRisk = statusUpper === "ABANDONED" && Number(c.value ?? 0) >= Number(minOrderValue || 0) && hasContact;

    // optional discount fields (only if columns exist / selected)
    const hasDiscountSuggest =
      sb && Object.prototype.hasOwnProperty.call(sb as any, "discount_suggest");
    const hasDiscountPercent =
      sb && Object.prototype.hasOwnProperty.call(sb as any, "discount_percent");

    const discountSuggest = hasDiscountSuggest
      ? ((sb as any).discount_suggest == null ? null : Boolean((sb as any).discount_suggest))
      : undefined;

    const dpRaw = hasDiscountPercent ? (sb as any).discount_percent : undefined;
    const discountPercent =
      hasDiscountPercent
        ? (dpRaw == null ? null : Number(dpRaw))
        : undefined;

    return {
      checkoutId,
      status: String(c.status),
      createdAt: new Date(c.createdAt).toISOString(),
      updatedAt: new Date(c.updatedAt).toISOString(),
      abandonedAt: c.abandonedAt ? new Date(c.abandonedAt).toISOString() : null,
      customerName: c.customerName ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
      value: Number(c.value ?? 0),
      currency: String(c.currency ?? "USD"),

      itemsJson: c.itemsJson ?? null,
      cartPreview,
      thumbUrl,
      itemsCount: count,

      recoveredAt: recoveredAtIso,
      recoveredOrderId,
      recoveredAmount: recoveredAmountSafe,

      eligibleAtRisk,

      callStatus: j ? String(j.status) : null,
      callOutcome: (sb as any)?.call_outcome ? String((sb as any).call_outcome) : null,
      aiStatus: (sb as any)?.ai_status ? String((sb as any).ai_status) : null,
      buyProbabilityPct,
      recordingUrl,
      logUrl: safeStr((sb as any)?.log_url).trim() ? String((sb as any).log_url) : null,

      nextBestAction: safeStr((sb as any)?.next_best_action || (sb as any)?.best_next_action).trim()
        ? String((sb as any)?.next_best_action || (sb as any)?.best_next_action)
        : null,
      followUpMessage: safeStr((sb as any)?.follow_up_message).trim() ? String((sb as any)?.follow_up_message) : null,
      summaryClean: safeStr((sb as any)?.summary_clean || (sb as any)?.summary).trim()
        ? String((sb as any)?.summary_clean || (sb as any)?.summary)
        : null,

      sentiment: safeStr((sb as any)?.sentiment).trim() ? String((sb as any)?.sentiment) : null,
      tone: safeStr((sb as any)?.tone).trim() ? String((sb as any)?.tone) : null,
      customerIntent: safeStr((sb as any)?.customer_intent).trim() ? String((sb as any)?.customer_intent) : null,
      latestStatus: safeStr((sb as any)?.latest_status).trim() ? String((sb as any)?.latest_status) : null,
      endedReason: safeStr((sb as any)?.ended_reason).trim() ? String((sb as any)?.ended_reason) : null,
      answered: typeof (sb as any)?.answered === "boolean" ? Boolean((sb as any)?.answered) : null,
      voicemail: typeof (sb as any)?.voicemail === "boolean" ? Boolean((sb as any)?.voicemail) : null,

      discountSuggest,
      discountPercent: discountPercent == null ? discountPercent : Number.isFinite(discountPercent) ? discountPercent : null,

      latestJobId: j?.id ? String(j.id) : null,
      latestProviderCallId: j?.providerCallId ? String(j.providerCallId) : null,
    };
  });

  return { shop, rows } satisfies LoaderData;
};

/* ---------------- Core derived rules ---------------- */
function hasContact(r: Row) {
  return !!safeStr(r.phone).trim() || !!safeStr(r.email).trim();
}

function isRecovered(r: Row) {
  const s = safeStr(r.status).toUpperCase();
  if (s === "RECOVERED" || s === "CONVERTED") return true;
  if (r.recoveredAt != null) return true;
  if (r.recoveredOrderId != null) return true;
  return isRecoveredOutcome(r.callOutcome);
}

function recoveredRowRevenue(r: Row) {
  const ra = r.recoveredAmount == null ? 0 : Number(r.recoveredAmount);
  const useRecovered = Number.isFinite(ra) && ra > 0;
  return useRecovered ? ra : Number(r.value || 0);
}

function urgencyScore(r: Row) {
  // higher score = higher urgency
  let score = 0;

  const status = safeStr(r.status).toUpperCase();
  if (r.eligibleAtRisk) score += 95;
  else if (status === "ABANDONED") score += 70;
  else if (status === "OPEN") score += 35;

  const callStatus = safeStr(r.callStatus).toUpperCase();
  if (callStatus === "FAILED") score += 35;
  if (!callStatus) score += 20;
  if (callStatus === "QUEUED") score += 10;
  if (callStatus === "CALLING") score += 6;

  const n = normalizeOutcome(r.callOutcome);
  if (n === "needs_followup") score += 24;
  if (n === "voicemail" || n === "no_answer") score += 18;
  if (n === "not_recovered" || n === "not_interested") score += 10;

  const buy = typeof r.buyProbabilityPct === "number" ? r.buyProbabilityPct : 0;
  score += Math.round(buy * 0.35);

  const val = Number(r.value || 0);
  score += Math.min(30, Math.round(val / 100));

  // stale work gets pushed down slightly; recent gets a bump
  const t = Date.parse(r.updatedAt);
  if (Number.isFinite(t)) {
    const ageHours = Math.max(0, (Date.now() - t) / (1000 * 60 * 60));
    if (ageHours < 6) score += 6;
    else if (ageHours < 24) score += 2;
    else if (ageHours > 168) score -= 6;
  }

  return score;
}

/* ---------------- UI helpers ---------------- */
function Badge({ tone, children, label }: { tone: BadgeTone; children: React.ReactNode; label?: string }) {
  // @ts-ignore
  return <s-badge tone={tone} accessibilityLabel={label || ""}>{children}</s-badge>;
}

type FilterKey = "all" | "abandoned" | "followups" | "high_intent" | "no_answer" | "discounts";

function isFollowUpCandidate(r: Row) {
  const n = normalizeOutcome(r.callOutcome);
  return n === "needs_followup" || !!safeStr(r.nextBestAction).trim() || !!safeStr(r.followUpMessage).trim();
}

function isNoAnswerCandidate(r: Row) {
  const n = normalizeOutcome(r.callOutcome);
  return n === "no_answer" || r.answered === false;
}

function isDiscountCandidate(r: Row) {
  const ds = r.discountSuggest;
  const dp = r.discountPercent;
  const dpNum = dp == null ? 0 : Number(dp);
  const dpOk = Number.isFinite(dpNum) && dpNum > 0;
  return ds === true || dpOk;
}

export default function Checkouts() {
  const { shop, rows } = useLoaderData<typeof loader>();

  const currency = (rows.find((r) => safeStr(r.currency))?.currency ?? "USD").toUpperCase();

  const recoveredRows = React.useMemo(() => rows.filter(isRecovered), [rows]);
  const eligibleAtRiskRows = React.useMemo(() => rows.filter((r) => r.eligibleAtRisk), [rows]);

  const recoveredRevenue = React.useMemo(() => {
    let n = 0;
    for (const r of recoveredRows) n += recoveredRowRevenue(r);
    return n;
  }, [recoveredRows]);

  const atRiskRevenue = React.useMemo(() => {
    let n = 0;
    for (const r of eligibleAtRiskRows) n += Number(r.value || 0);
    return n;
  }, [eligibleAtRiskRows]);

  const recoveredCount = recoveredRows.length;
  const eligibleAtRiskCount = eligibleAtRiskRows.length;

  const winRate = React.useMemo(() => {
    const denom = recoveredCount + eligibleAtRiskCount;
    if (denom <= 0) return 0;
    return pct(recoveredCount, denom);
  }, [recoveredCount, eligibleAtRiskCount]);

  const latest = rows[0] ?? null;

  const mostUrgentAtRisk = React.useMemo(() => {
    if (eligibleAtRiskRows.length === 0) return null;
    return eligibleAtRiskRows
      .slice()
      .sort((a, b) => {
        const u = urgencyScore(b) - urgencyScore(a);
        if (u !== 0) return u;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      })[0] ?? null;
  }, [eligibleAtRiskRows]);

  const recoveredRecent = React.useMemo(() => {
    return recoveredRows
      .slice()
      .sort((a, b) => {
        const ta = Date.parse(a.recoveredAt || a.updatedAt);
        const tb = Date.parse(b.recoveredAt || b.updatedAt);
        return tb - ta;
      })
      .slice(0, 6);
  }, [recoveredRows]);

  // base work list (non-recovered), urgency-sorted
  const baseWorkSorted = React.useMemo(() => {
    return rows
      .filter((r) => !isRecovered(r))
      .slice()
      .sort((a, b) => urgencyScore(b) - urgencyScore(a));
  }, [rows]);

  const hasDiscountFields = React.useMemo(() => {
    return baseWorkSorted.some((r) => r.discountSuggest !== undefined || r.discountPercent !== undefined);
  }, [baseWorkSorted]);

  const counts = React.useMemo(() => {
    const c = {
      all: baseWorkSorted.length,
      abandoned: 0,
      followups: 0,
      high_intent: 0,
      no_answer: 0,
      discounts: 0,
    };

    for (const r of baseWorkSorted) {
      if (r.eligibleAtRisk) c.abandoned += 1;
      if (isFollowUpCandidate(r)) c.followups += 1;
      if (typeof r.buyProbabilityPct === "number" && r.buyProbabilityPct >= 70) c.high_intent += 1;
      if (isNoAnswerCandidate(r)) c.no_answer += 1;
      if (isDiscountCandidate(r)) c.discounts += 1;
    }

    return c;
  }, [baseWorkSorted]);

  const [activeFilter, setActiveFilter] = React.useState<FilterKey>("all");

  const filteredWorkRows = React.useMemo(() => {
    switch (activeFilter) {
      case "abandoned":
        return baseWorkSorted.filter((r) => r.eligibleAtRisk);
      case "followups":
        return baseWorkSorted.filter(isFollowUpCandidate);
      case "high_intent":
        return baseWorkSorted.filter((r) => typeof r.buyProbabilityPct === "number" && r.buyProbabilityPct >= 70);
      case "no_answer":
        return baseWorkSorted.filter(isNoAnswerCandidate);
      case "discounts":
        return baseWorkSorted.filter(isDiscountCandidate);
      case "all":
      default:
        return baseWorkSorted;
    }
  }, [baseWorkSorted, activeFilter]);

  const toReviewCount = filteredWorkRows.length;
  const tableRows = React.useMemo(() => filteredWorkRows.slice(0, 80), [filteredWorkRows]);

  const [selectedId, setSelectedId] = React.useState<string | null>(() => {
    return tableRows[0]?.checkoutId ?? baseWorkSorted[0]?.checkoutId ?? latest?.checkoutId ?? null;
  });

  // keep selection valid, prefer current filtered set
  React.useEffect(() => {
    const preferred = tableRows[0]?.checkoutId ?? baseWorkSorted[0]?.checkoutId ?? latest?.checkoutId ?? null;
    if (!selectedId) {
      setSelectedId(preferred);
      return;
    }
    const exists = rows.some((r) => r.checkoutId === selectedId);
    if (!exists) {
      setSelectedId(preferred);
      return;
    }
    // if selected is not in filtered set and there is a filtered set, snap to top
    if (filteredWorkRows.length > 0 && !filteredWorkRows.some((r) => r.checkoutId === selectedId)) {
      setSelectedId(preferred);
    }
  }, [selectedId, rows, tableRows, baseWorkSorted, latest, filteredWorkRows]);

  const selected = React.useMemo(() => rows.find((r) => r.checkoutId === selectedId) ?? null, [rows, selectedId]);

  // right-panel details fetch (full sb fields)
  const detailsFetcher = useFetcher<any>();
  React.useEffect(() => {
    if (!selected?.checkoutId) return;
    detailsFetcher.load(withSearch(`/app/checkouts/${encodeURIComponent(selected.checkoutId)}`));
  }, [selected?.checkoutId]);

  const details = detailsFetcher.data?.shop ? detailsFetcher.data : null;
  const sb = details?.sb ?? null;
  const loadingDetails = detailsFetcher.state !== "idle" && !details;

  const itemsForDetails = React.useMemo(() => {
    const itemsJson = details?.checkout?.itemsJson ?? selected?.itemsJson ?? null;
    return toItemsArray(itemsJson);
  }, [details?.checkout?.itemsJson, selected?.itemsJson]);

  const [modalKind, setModalKind] = React.useState<null | "transcript" | "raw" | "evidence">(null);

  const compactCell: React.CSSProperties = { paddingTop: 6, paddingBottom: 6, verticalAlign: "top" };
  const mono: React.CSSProperties = {
    margin: 0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12,
    fontWeight: 650,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  const effectiveRecordingUrl = safeStr(details?.recordingUrl ?? selected?.recordingUrl).trim() || "";
  const effectiveLogUrl = safeStr(sb?.log_url).trim() || safeStr(selected?.logUrl).trim() || "";

  function chipProps(key: FilterKey) {
    const selected = activeFilter === key;
    return {
      selected,
      onClick: () => setActiveFilter(key),
    };
  }

  return (
    <>
      {/* @ts-ignore */}
      <s-page heading="Checkouts" inlineSize="large">
        {/* TOP VALUE STRIP */}
        {/* @ts-ignore */}
        <s-section>
          {/* @ts-ignore */}
          <s-grid gap="base" gridTemplateColumns="@container (inline-size < 960px) 1fr, 1.2fr 0.8fr">
            {/* PERFORMANCE */}
            {/* @ts-ignore */}
            <s-box border="base" borderRadius="base" padding="base">
              {/* @ts-ignore */}
              <s-stack gap="tight">
                {/* @ts-ignore */}
                <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center", flexWrap: "wrap" }}>
                  {/* @ts-ignore */}
                  <s-text variant="headingMd">Performance</s-text>
                  {/* @ts-ignore */}
                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap", alignItems: "center" }}>
                    {/* @ts-ignore */}
                    <s-badge tone="success">{recoveredCount} wins</s-badge>
                    {/* @ts-ignore */}
                    <s-badge tone="warning">{eligibleAtRiskCount} at-risk</s-badge>
                    {/* @ts-ignore */}
                    <s-badge tone="info">{winRate}% win rate</s-badge>
                  </s-stack>
                </s-stack>

                {/* @ts-ignore */}
                <s-grid gap="base" gridTemplateColumns="@container (inline-size < 860px) 1fr, 1fr 1fr 1fr">
                  {/* Recovered revenue */}
                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base" background="subdued">
                    {/* @ts-ignore */}
                    <s-stack gap="tight">
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">Recovered revenue</s-text>
                      {/* @ts-ignore */}
                      <s-text variant="headingLg">{fmtMoney(recoveredRevenue, currency)}</s-text>
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">
                        Uses recovered amount when available
                      </s-text>
                    </s-stack>
                  </s-box>

                  {/* At-risk revenue */}
                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base" background="subdued">
                    {/* @ts-ignore */}
                    <s-stack gap="tight">
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">At-risk revenue</s-text>
                      {/* @ts-ignore */}
                      <s-text variant="headingLg">{fmtMoney(atRiskRevenue, currency)}</s-text>
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">
                        Eligible abandoned (min value + contact)
                      </s-text>
                    </s-stack>
                  </s-box>

                  {/* Win rate */}
                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base" background="subdued">
                    {/* @ts-ignore */}
                    <s-stack gap="tight">
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">Win rate</s-text>
                      {/* @ts-ignore */}
                      <s-text variant="headingLg">{winRate}%</s-text>
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">
                        wins / (wins + eligible at-risk)
                      </s-text>
                    </s-stack>
                  </s-box>

                  {/* Compact recency */}
                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base" background="subdued">
                    {/* @ts-ignore */}
                    <s-stack gap="tight">
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">
                        {mostUrgentAtRisk ? "Most urgent at-risk" : "Most recent update"}
                      </s-text>
                      {/* @ts-ignore */}
                      <s-text variant="headingMd">
                        {mostUrgentAtRisk
                          ? fmtMoney(Number(mostUrgentAtRisk.value || 0), mostUrgentAtRisk.currency)
                          : latest
                            ? fmtMoney(Number(latest.value || 0), latest.currency)
                            : "—"}
                      </s-text>
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {mostUrgentAtRisk
                          ? `${safeStr(mostUrgentAtRisk.customerName) || `Checkout #${mostUrgentAtRisk.checkoutId}`} • ${formatWhen(mostUrgentAtRisk.updatedAt)}`
                          : latest
                            ? `${safeStr(latest.customerName) || `Checkout #${latest.checkoutId}`} • ${formatWhen(latest.updatedAt)}`
                            : "—"}
                      </s-text>
                    </s-stack>
                  </s-box>
                </s-grid>
              </s-stack>
            </s-box>

            {/* RECOVERED WINS – SPECIAL BOX */}
            {/* @ts-ignore */}
            <s-box border="base" borderRadius="base" padding="base" style={{ background: "rgba(0,128,96,0.08)" }}>
              {/* @ts-ignore */}
              <s-stack gap="tight">
                {/* @ts-ignore */}
                <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center" }}>
                  {/* @ts-ignore */}
                  <s-text variant="headingMd">Recovered wins</s-text>
                  {/* @ts-ignore */}
                  <s-badge tone="success">{recoveredCount}</s-badge>
                </s-stack>

                {/* @ts-ignore */}
                <s-box border="base" borderRadius="base" style={{ overflow: "hidden", background: "rgba(255,255,255,0.7)" }}>
                  {/* @ts-ignore */}
                  <s-table style={{ tableLayout: "fixed", width: "100%" }}>
                    {/* @ts-ignore */}
                    <s-table-header-row>
                      {/* @ts-ignore */}
                      <s-table-header>Customer</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header format="numeric" style={{ width: 130 }}>Amount</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 140 }}>When</s-table-header>
                    </s-table-header-row>

                    {/* @ts-ignore */}
                    <s-table-body>
                      {recoveredRecent.length === 0 ? (
                        // @ts-ignore
                        <s-table-row>
                          {/* @ts-ignore */}
                          <s-table-cell colSpan={3}>
                            {/* @ts-ignore */}
                            <s-text tone="subdued">No recovered checkouts yet.</s-text>
                          </s-table-cell>
                        </s-table-row>
                      ) : (
                        recoveredRecent.map((r) => {
                          const id = r.checkoutId;
                          const whenIso = r.recoveredAt || r.updatedAt;
                          const amt = recoveredRowRevenue(r);
                          return (
                            // @ts-ignore
                            <s-table-row key={id} clickDelegate={`win-${id}`}>
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                {/* @ts-ignore */}
                                <s-link
                                  id={`win-${id}`}
                                  href="#"
                                  onClick={(e: any) => {
                                    e.preventDefault();
                                    setSelectedId(id);
                                  }}
                                >
                                  {/* @ts-ignore */}
                                  <s-text fontWeight="semibold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {safeStr(r.customerName) || `Checkout #${id}`}
                                  </s-text>
                                </s-link>
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">
                                  {outcomeLabel(r.callOutcome)}
                                </s-text>
                              </s-table-cell>
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>{fmtMoney(amt, r.currency)}</s-table-cell>
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>{formatWhen(whenIso)}</s-table-cell>
                            </s-table-row>
                          );
                        })
                      )}
                    </s-table-body>
                  </s-table>
                </s-box>
              </s-stack>
            </s-box>
          </s-grid>
        </s-section>

        {/* MAIN: WORK LIST + DETAILS */}
        {/* @ts-ignore */}
        <s-section>
          {/* @ts-ignore */}
          <s-grid gap="base" gridTemplateColumns="@container (inline-size < 1100px) 1fr, 1.15fr 0.85fr">
            {/* LEFT: ACTION QUEUE */}
            {/* @ts-ignore */}
            <s-section>
              {/* @ts-ignore */}
              <s-stack gap="tight">
                {/* @ts-ignore */}
                <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center", flexWrap: "wrap" }}>
                  {/* @ts-ignore */}
                  <s-text variant="headingMd">Action queue</s-text>
                  {/* @ts-ignore */}
                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap", alignItems: "center" }}>
                    {/* @ts-ignore */}
                    <s-badge tone="info">{toReviewCount} to review</s-badge>
                    {/* @ts-ignore */}
                    <s-badge tone="neutral">Urgency sorted</s-badge>
                  </s-stack>
                </s-stack>

                {/* FILTER CHIPS */}
                {/* @ts-ignore */}
                <s-box border="base" borderRadius="base" padding="base" background="subdued">
                  {/* @ts-ignore */}
                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap", alignItems: "center" }}>
                    {/* @ts-ignore */}
                    <s-chip {...chipProps("all")}>All ({counts.all})</s-chip>
                    {/* @ts-ignore */}
                    <s-chip {...chipProps("abandoned")}>Abandoned ({counts.abandoned})</s-chip>
                    {/* @ts-ignore */}
                    <s-chip {...chipProps("followups")}>Follow-ups ({counts.followups})</s-chip>
                    {/* @ts-ignore */}
                    <s-chip {...chipProps("high_intent")}>High intent ({counts.high_intent})</s-chip>
                    {/* @ts-ignore */}
                    <s-chip {...chipProps("no_answer")}>No answer ({counts.no_answer})</s-chip>
                    {hasDiscountFields ? (
                      // @ts-ignore
                      <s-chip {...chipProps("discounts")}>Discounts ({counts.discounts})</s-chip>
                    ) : null}
                  </s-stack>
                </s-box>

                {/* TABLE */}
                {/* @ts-ignore */}
                <s-box border="base" borderRadius="base" style={{ overflow: "hidden" }}>
                  {/* @ts-ignore */}
                  <s-table style={{ tableLayout: "fixed", width: "100%" }}>
                    {/* @ts-ignore */}
                    <s-table-header-row>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 60 }}>Img</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header>Customer / Cart</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header format="numeric" style={{ width: 120 }}>Value</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 200 }}>Signals</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 260 }}>Next step</s-table-header>
                    </s-table-header-row>

                    {/* @ts-ignore */}
                    <s-table-body>
                      {tableRows.length === 0 ? (
                        // @ts-ignore
                        <s-table-row>
                          {/* @ts-ignore */}
                          <s-table-cell colSpan={5}>
                            {/* @ts-ignore */}
                            <s-text tone="subdued">Nothing to work right now.</s-text>
                          </s-table-cell>
                        </s-table-row>
                      ) : (
                        tableRows.map((r) => {
                          const isSel = r.checkoutId === selectedId;
                          const id = r.checkoutId;

                          const checkoutTone = toneForCheckoutStatus(r.status);
                          const callTone = r.callStatus ? toneForJobStatus(r.callStatus) : "neutral";
                          const outcomeTone = toneForOutcome(r.callOutcome);

                          const customer = safeStr(r.customerName) || "—";
                          const cartLine = safeStr(r.cartPreview);

                          const nba = safeStr(r.nextBestAction).trim();
                          const follow = safeStr(r.followUpMessage).trim();
                          const nextStep = nba || (follow ? "Send follow-up message" : "—");

                          const buyBadge =
                            typeof r.buyProbabilityPct === "number" ? `BUY ${r.buyProbabilityPct}%` : "BUY —";

                          return (
                            // @ts-ignore
                            <s-table-row
                              key={id}
                              clickDelegate={`open-${id}`}
                              style={isSel ? { background: "var(--p-color-bg-surface-secondary)" } : undefined}
                            >
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                {/* @ts-ignore */}
                                <s-thumbnail
                                  src={r.thumbUrl || undefined}
                                  alt={r.thumbUrl ? "Item" : "No image"}
                                  size="small-200"
                                />
                              </s-table-cell>

                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                {/* @ts-ignore */}
                                <s-stack gap="tight">
                                  {/* @ts-ignore */}
                                  <s-stack direction="inline" gap="tight" style={{ alignItems: "center", flexWrap: "wrap" }}>
                                    {/* @ts-ignore */}
                                    <s-link
                                      id={`open-${id}`}
                                      href="#"
                                      onClick={(e: any) => {
                                        e.preventDefault();
                                        setSelectedId(id);
                                      }}
                                    >
                                      {/* @ts-ignore */}
                                      <s-text fontWeight="semibold">{customer}</s-text>
                                    </s-link>
                                    {/* @ts-ignore */}
                                    <s-text tone="subdued" variant="bodySm">#{id}</s-text>
                                    {r.eligibleAtRisk ? (
                                      // @ts-ignore
                                      <s-badge tone="warning">AT-RISK</s-badge>
                                    ) : null}
                                  </s-stack>

                                  {/* @ts-ignore */}
                                  <s-text
                                    tone="subdued"
                                    variant="bodySm"
                                    style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                    title={cartLine}
                                  >
                                    {cartLine || "—"}
                                  </s-text>

                                  {/* @ts-ignore */}
                                  <s-text tone="subdued" variant="bodySm">
                                    Updated {formatWhen(r.updatedAt)}
                                  </s-text>
                                </s-stack>
                              </s-table-cell>

                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                {/* @ts-ignore */}
                                <s-text fontWeight="semibold">{fmtMoney(Number(r.value || 0), r.currency)}</s-text>
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">{r.itemsCount ? `${r.itemsCount} items` : "0 items"}</s-text>
                              </s-table-cell>

                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                {/* @ts-ignore */}
                                <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                                  {/* @ts-ignore */}
                                  <s-badge tone={checkoutTone}>{safeStr(r.status).toUpperCase()}</s-badge>
                                  {/* @ts-ignore */}
                                  <s-badge tone={callTone}>{r.callStatus ? safeStr(r.callStatus).toUpperCase() : "NO CALL"}</s-badge>
                                  {/* @ts-ignore */}
                                  <s-badge tone={outcomeTone}>{outcomeLabel(r.callOutcome)}</s-badge>
                                  {/* @ts-ignore */}
                                  <s-badge tone={typeof r.buyProbabilityPct === "number" ? "info" : "neutral"}>{buyBadge}</s-badge>
                                </s-stack>
                              </s-table-cell>

                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                {/* @ts-ignore */}
                                <s-stack gap="tight">
                                  {/* @ts-ignore */}
                                  <s-text
                                    tone={nextStep === "—" ? "subdued" : "base"}
                                    style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                    title={nextStep}
                                  >
                                    {nextStep}
                                  </s-text>

                                  {/* @ts-ignore */}
                                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                                    {/* @ts-ignore */}
                                    <s-button variant="secondary" onClick={() => setSelectedId(id)}>
                                      Open
                                    </s-button>
                                    {/* @ts-ignore */}
                                    <s-button
                                      variant="tertiary"
                                      disabled={!r.recordingUrl}
                                      onClick={() => {
                                        if (r.recordingUrl) window.open(r.recordingUrl, "_blank", "noreferrer");
                                      }}
                                    >
                                      Recording
                                    </s-button>
                                    {/* @ts-ignore */}
                                    <s-button
                                      variant="tertiary"
                                      disabled={!r.logUrl}
                                      onClick={() => {
                                        if (r.logUrl) window.open(r.logUrl, "_blank", "noreferrer");
                                      }}
                                    >
                                      Logs
                                    </s-button>
                                  </s-stack>
                                </s-stack>
                              </s-table-cell>
                            </s-table-row>
                          );
                        })
                      )}
                    </s-table-body>
                  </s-table>
                </s-box>
              </s-stack>
            </s-section>

            {/* RIGHT: DETAILS (STICKY) */}
            {/* @ts-ignore */}
            <s-box style={{ position: "sticky", top: 16, alignSelf: "start" }}>
              {/* @ts-ignore */}
              <s-section>
                {/* @ts-ignore */}
                <s-box border="base" borderRadius="base" padding="base">
                  {/* @ts-ignore */}
                  <s-stack gap="base">
                    {/* Header */}
                    {/* @ts-ignore */}
                    <s-stack direction="inline" align="space-between" gap="base" style={{ flexWrap: "wrap", alignItems: "center" }}>
                      {/* @ts-ignore */}
                      <s-stack gap="tight">
                        {/* @ts-ignore */}
                        <s-text variant="headingMd">Details</s-text>
                        {/* @ts-ignore */}
                        <s-text tone="subdued" variant="bodySm">
                          {selected ? `Checkout #${selected.checkoutId}` : "Select a checkout"}
                        </s-text>
                      </s-stack>
                      {loadingDetails ? (
                        // @ts-ignore
                        <s-spinner size="small" />
                      ) : null}
                    </s-stack>

                    {/* @ts-ignore */}
                    <s-divider />

                    {!selected ? (
                      // @ts-ignore
                      <s-text tone="subdued">—</s-text>
                    ) : loadingDetails ? (
                      // @ts-ignore
                      <s-text tone="subdued">Loading…</s-text>
                    ) : (
                      // @ts-ignore
                      <s-stack gap="base">
                        {/* 1) Status badges row */}
                        {/* @ts-ignore */}
                        <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                          {/* @ts-ignore */}
                          <s-badge tone={toneForCheckoutStatus(details?.checkout?.status ?? selected.status)}>
                            {safeStr(details?.checkout?.status ?? selected.status).toUpperCase()}
                          </s-badge>

                          {details?.latestJob?.status ? (
                            // @ts-ignore
                            <s-badge tone={toneForJobStatus(details.latestJob.status)}>
                              {safeStr(details.latestJob.status).toUpperCase()}
                            </s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">NO JOB</s-badge>
                          )}

                          {/* @ts-ignore */}
                          <s-badge tone={toneForOutcome(sb?.call_outcome ?? selected.callOutcome)}>
                            {outcomeLabel(sb?.call_outcome ?? selected.callOutcome)}
                          </s-badge>

                          {sb?.ai_status ? (
                            // @ts-ignore
                            <s-badge tone="info">{`AI ${safeStr(sb.ai_status).toUpperCase()}`}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">AI —</s-badge>
                          )}

                          {typeof sb?.buy_probability === "number" ? (
                            // @ts-ignore
                            <s-badge tone="info">{`BUY ${Math.round(sb.buy_probability)}%`}</s-badge>
                          ) : typeof selected.buyProbabilityPct === "number" ? (
                            // @ts-ignore
                            <s-badge tone="info">{`BUY ${selected.buyProbabilityPct}%`}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">BUY —</s-badge>
                          )}

                          {sb?.answered != null ? (
                            // @ts-ignore
                            <s-badge tone={sb.answered ? "success" : "warning"}>{sb.answered ? "ANSWERED" : "NO ANSWER"}</s-badge>
                          ) : selected.answered != null ? (
                            // @ts-ignore
                            <s-badge tone={selected.answered ? "success" : "warning"}>{selected.answered ? "ANSWERED" : "NO ANSWER"}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">ANSWER —</s-badge>
                          )}

                          {sb?.voicemail != null ? (
                            // @ts-ignore
                            <s-badge tone={sb.voicemail ? "warning" : "neutral"}>{sb.voicemail ? "VOICEMAIL" : "NO VOICEMAIL"}</s-badge>
                          ) : selected.voicemail != null ? (
                            // @ts-ignore
                            <s-badge tone={selected.voicemail ? "warning" : "neutral"}>{selected.voicemail ? "VOICEMAIL" : "NO VOICEMAIL"}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">VOICEMAIL —</s-badge>
                          )}
                        </s-stack>

                        {/* 2) Customer + Cart total box */}
                        {/* @ts-ignore */}
                        <s-box padding="base" border="base" borderRadius="base" background="subdued">
                          {/* @ts-ignore */}
                          <s-grid gap="base" gridTemplateColumns="1fr 1fr">
                            {/* @ts-ignore */}
                            <s-stack gap="tight">
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">Customer</s-text>
                              {/* @ts-ignore */}
                              <s-text fontWeight="semibold">{tiny(details?.checkout?.customerName ?? selected.customerName)}</s-text>
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">{tiny(details?.checkout?.phone ?? selected.phone)}</s-text>
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">{tiny(details?.checkout?.email ?? selected.email)}</s-text>
                            </s-stack>

                            {/* @ts-ignore */}
                            <s-stack gap="tight">
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">Cart total</s-text>
                              {/* @ts-ignore */}
                              <s-text fontWeight="semibold">
                                {fmtMoney(
                                  Number(details?.checkout?.value ?? selected.value ?? 0),
                                  String(details?.checkout?.currency ?? selected.currency),
                                )}
                              </s-text>
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">Updated {formatWhen(details?.checkout?.updatedAt ?? selected.updatedAt)}</s-text>
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">
                                Abandoned {details?.checkout?.abandonedAt ? formatWhen(details.checkout.abandonedAt) : selected.abandonedAt ? formatWhen(selected.abandonedAt) : "—"}
                              </s-text>
                            </s-stack>
                          </s-grid>
                        </s-box>

                        {/* 3) Primary actions row */}
                        {/* @ts-ignore */}
                        <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                          {/* @ts-ignore */}
                          <s-button
                            variant="primary"
                            disabled={!effectiveRecordingUrl}
                            onClick={() => {
                              if (effectiveRecordingUrl) window.open(effectiveRecordingUrl, "_blank", "noreferrer");
                            }}
                          >
                            Recording
                          </s-button>

                          {/* @ts-ignore */}
                          <s-button
                            variant="secondary"
                            disabled={!effectiveLogUrl}
                            onClick={() => {
                              if (effectiveLogUrl) window.open(effectiveLogUrl, "_blank", "noreferrer");
                            }}
                          >
                            Logs
                          </s-button>

                          {/* @ts-ignore */}
                          <s-button variant="secondary" disabled={!safeStr(sb?.transcript).trim()} onClick={() => setModalKind("transcript")}>
                            Transcript
                          </s-button>

                          {/* @ts-ignore */}
                          <s-button variant="secondary" onClick={() => setModalKind("evidence")}>
                            Evidence
                          </s-button>

                          {/* @ts-ignore */}
                          <s-button variant="secondary" onClick={() => setModalKind("raw")}>
                            Raw
                          </s-button>
                        </s-stack>

                        {/* 4) Next best action focus box */}
                        {/* @ts-ignore */}
                        <s-box border="base" borderRadius="base" padding="base" style={{ background: "rgba(0,91,211,0.06)" }}>
                          {/* @ts-ignore */}
                          <s-stack gap="tight">
                            {/* @ts-ignore */}
                            <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center", flexWrap: "wrap" }}>
                              {/* @ts-ignore */}
                              <s-text variant="headingSm">Next best action</s-text>
                              {/* @ts-ignore */}
                              <s-badge tone="info">AI</s-badge>
                            </s-stack>
                            {/* @ts-ignore */}
                            <s-text>
                              {safeStr(sb?.next_best_action || sb?.best_next_action).trim() ||
                                safeStr(selected.nextBestAction).trim() ||
                                "—"}
                            </s-text>
                          </s-stack>
                        </s-box>

                        {/* 5) Follow-up message box with Copy */}
                        {/* @ts-ignore */}
                        <s-box border="base" borderRadius="base" padding="base">
                          {/* @ts-ignore */}
                          <s-stack gap="tight">
                            {/* @ts-ignore */}
                            <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center", flexWrap: "wrap" }}>
                              {/* @ts-ignore */}
                              <s-text variant="headingSm">Follow-up message</s-text>
                              {/* @ts-ignore */}
                              <s-button
                                variant="tertiary"
                                disabled={!safeStr(sb?.follow_up_message || selected.followUpMessage).trim()}
                                onClick={() => {
                                  const txt = safeStr(sb?.follow_up_message || selected.followUpMessage).trim();
                                  if (txt) clip(txt);
                                }}
                              >
                                Copy
                              </s-button>
                            </s-stack>
                            <pre style={mono}>{safeStr(sb?.follow_up_message || selected.followUpMessage) || "—"}</pre>
                          </s-stack>
                        </s-box>

                        {/* 6) Conversation signals grid */}
                        {/* @ts-ignore */}
                        <s-box border="base" borderRadius="base" padding="base">
                          {/* @ts-ignore */}
                          <s-stack gap="tight">
                            {/* @ts-ignore */}
                            <s-text variant="headingSm">Conversation signals</s-text>
                            {/* @ts-ignore */}
                            <s-grid gap="base" gridTemplateColumns="1fr 1fr">
                              {/* @ts-ignore */}
                              <s-stack gap="tight">
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">Intent</s-text>
                                {/* @ts-ignore */}
                                <s-text>{tiny(sb?.customer_intent || selected.customerIntent)}</s-text>
                              </s-stack>

                              {/* @ts-ignore */}
                              <s-stack gap="tight">
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">Sentiment</s-text>
                                {/* @ts-ignore */}
                                <s-text>{tiny(sb?.sentiment || selected.sentiment)}</s-text>
                              </s-stack>

                              {/* @ts-ignore */}
                              <s-stack gap="tight">
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">Tone</s-text>
                                {/* @ts-ignore */}
                                <s-text>{tiny(sb?.tone || selected.tone)}</s-text>
                              </s-stack>

                              {/* @ts-ignore */}
                              <s-stack gap="tight">
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">End reason</s-text>
                                {/* @ts-ignore */}
                                <s-text>{tiny(sb?.ended_reason || selected.endedReason)}</s-text>
                              </s-stack>

                              {/* @ts-ignore */}
                              <s-stack gap="tight">
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">Latest status</s-text>
                                {/* @ts-ignore */}
                                <s-text>{tiny(sb?.latest_status || selected.latestStatus)}</s-text>
                              </s-stack>

                              {/* @ts-ignore */}
                              <s-stack gap="tight">
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">AI status</s-text>
                                {/* @ts-ignore */}
                                <s-text>{tiny(sb?.ai_status || selected.aiStatus)}</s-text>
                              </s-stack>
                            </s-grid>
                          </s-stack>
                        </s-box>

                        {/* 7) Items table */}
                        {/* @ts-ignore */}
                        <s-box border="base" borderRadius="base" style={{ overflow: "hidden" }}>
                          {/* @ts-ignore */}
                          <s-table style={{ tableLayout: "fixed", width: "100%" }}>
                            {/* @ts-ignore */}
                            <s-table-header-row>
                              {/* @ts-ignore */}
                              <s-table-header style={{ width: 60 }}>Img</s-table-header>
                              {/* @ts-ignore */}
                              <s-table-header>Item</s-table-header>
                              {/* @ts-ignore */}
                              <s-table-header style={{ width: 80 }} format="numeric">Qty</s-table-header>
                            </s-table-header-row>

                            {/* @ts-ignore */}
                            <s-table-body>
                              {itemsForDetails.length === 0 ? (
                                // @ts-ignore
                                <s-table-row>
                                  {/* @ts-ignore */}
                                  <s-table-cell colSpan={3}>
                                    {/* @ts-ignore */}
                                    <s-text tone="subdued">—</s-text>
                                  </s-table-cell>
                                </s-table-row>
                              ) : (
                                itemsForDetails.slice(0, 12).map((it, idx) => {
                                  const title = safeStr(it.title || it.name) || "Item";
                                  const qtyRaw = it.quantity ?? it.qty ?? "";
                                  const qty = safeStr(qtyRaw) || "—";
                                  const img = pickThumbFromItem(it);

                                  return (
                                    // @ts-ignore
                                    <s-table-row key={`${title}-${idx}`}>
                                      {/* @ts-ignore */}
                                      <s-table-cell style={compactCell}>
                                        {/* @ts-ignore */}
                                        <s-thumbnail src={img || undefined} alt={img ? title : "No image"} size="small-200" />
                                      </s-table-cell>
                                      {/* @ts-ignore */}
                                      <s-table-cell style={compactCell}>
                                        {/* @ts-ignore */}
                                        <s-text fontWeight="semibold" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                          {title}
                                        </s-text>
                                        {safeStr(it.variantTitle) ? (
                                          // @ts-ignore
                                          <s-text tone="subdued" variant="bodySm">{safeStr(it.variantTitle)}</s-text>
                                        ) : null}
                                      </s-table-cell>
                                      {/* @ts-ignore */}
                                      <s-table-cell style={compactCell}>{qty}</s-table-cell>
                                    </s-table-row>
                                  );
                                })
                              )}
                            </s-table-body>
                          </s-table>
                        </s-box>
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              </s-section>
            </s-box>
          </s-grid>
        </s-section>
      </s-page>

      {/* MODAL: transcript / evidence / raw */}
      {/* @ts-ignore */}
      <s-modal
        id="checkouts-modal"
        heading={
          modalKind === "transcript" ? "Transcript" : modalKind === "evidence" ? "Evidence" : modalKind === "raw" ? "Raw payload" : "Details"
        }
        padding="base"
        open={!!modalKind}
        onClose={() => setModalKind(null)}
      >
        {modalKind === "transcript" ? (
          <pre style={mono}>{safeStr(sb?.transcript) || "—"}</pre>
        ) : modalKind === "evidence" ? (
          // @ts-ignore
          <s-stack gap="base">
            {/* Summary + next action + follow-up */}
            {/* @ts-ignore */}
            <s-grid gap="base" gridTemplateColumns="@container (inline-size < 900px) 1fr, 1fr 1fr">
              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Summary</s-text>
                <pre style={mono}>{safeStr(sb?.summary_clean || sb?.summary) || "—"}</pre>
              </s-box>

              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Next best action</s-text>
                <pre style={mono}>{safeStr(sb?.next_best_action || sb?.best_next_action) || "—"}</pre>
              </s-box>

              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Follow-up message</s-text>
                <pre style={mono}>{safeStr(sb?.follow_up_message) || "—"}</pre>
              </s-box>
            </s-grid>

            {/* Key evidence fields */}
            {/* @ts-ignore */}
            <s-grid gap="base" gridTemplateColumns="@container (inline-size < 900px) 1fr, 1fr 1fr">
              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Key quotes</s-text>
                <pre style={mono}>{safeStr(sb?.key_quotes_text || sb?.key_quotes) || "—"}</pre>
              </s-box>

              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Objections</s-text>
                <pre style={mono}>{safeStr(sb?.objections_text || sb?.objections) || "—"}</pre>
              </s-box>

              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Issues to fix</s-text>
                <pre style={mono}>{safeStr(sb?.issues_to_fix_text || sb?.issues_to_fix) || "—"}</pre>
              </s-box>

              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Tags</s-text>
                <pre style={mono}>
                  {safeStr(sb?.tagcsv || (Array.isArray(sb?.tags) ? sb.tags.join(", ") : "")) || "—"}
                </pre>
              </s-box>

              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Ended reason</s-text>
                <pre style={mono}>{safeStr(sb?.ended_reason) || "—"}</pre>
              </s-box>

              {/* @ts-ignore */}
              <s-box border="base" borderRadius="base" padding="base">
                {/* @ts-ignore */}
                <s-text variant="headingSm">Latest status</s-text>
                <pre style={mono}>{safeStr(sb?.latest_status) || "—"}</pre>
              </s-box>
            </s-grid>
          </s-stack>
        ) : modalKind === "raw" ? (
          <pre style={mono}>
            {(() => {
              try {
                return JSON.stringify(
                  {
                    sb: sb ?? null,
                    checkout: details?.checkout ?? null,
                    latestJob: details?.latestJob ?? null,
                  },
                  null,
                  2,
                );
              } catch {
                return "—";
              }
            })()}
          </pre>
        ) : null}

        {/* @ts-ignore */}
        <s-button slot="secondary-actions" variant="secondary" onClick={() => setModalKind(null)}>
          Close
        </s-button>
      </s-modal>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);