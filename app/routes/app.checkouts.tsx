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
  const s = safeStr(outcome).toLowerCase();
  if (!s) return "neutral";
  if (s.includes("recovered") || s.includes("converted")) return "success";
  if (s.includes("no_answer") || s.includes("voicemail")) return "warning";
  if (s.includes("needs_follow") || s.includes("needs follow") || s.includes("follow")) return "warning";
  if (s.includes("not_recovered") || s.includes("not interested")) return "critical";
  return "info";
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

/* ---------------- Loader ---------------- */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureSettings(shop);

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

    const select = [
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
    ].join(",");

    const orParts: string[] = [];
    if (callIds.length) orParts.push(`call_id.in.(${callIds.join(",")})`);
    if (callJobIds.length) orParts.push(`call_job_id.in.(${callJobIds.join(",")})`);
    if (checkoutIds.length) orParts.push(`checkout_id.in.(${checkoutIds.join(",")})`);

    const params = new URLSearchParams();
    params.set("select", select);
    params.set("or", `(${orParts.join(",")})`);
    params.set("order", "last_received_at.desc,received_at.desc");

    const withShopParams = new URLSearchParams(params);
    withShopParams.set("shop", `eq.${opts.shop}`);

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
      if (!r.ok) return null as any;
      const data = (await r.json()) as SupabaseCallSummary[];
      return Array.isArray(data) ? data : [];
    }

    let data = await doFetch(withShopParams);
    if (data && data.length === 0) data = await doFetch(params);

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

      latestJobId: j?.id ? String(j.id) : null,
      latestProviderCallId: j?.providerCallId ? String(j.providerCallId) : null,
    };
  });

  return { shop, rows } satisfies LoaderData;
};

/* ---------------- UI helpers ---------------- */
function sumMoney(rows: Row[], pred: (r: Row) => boolean) {
  let n = 0;
  for (const r of rows) if (pred(r)) n += Number(r.value || 0);
  return n;
}

function isRecovered(r: Row) {
  const s = safeStr(r.status).toUpperCase();
  if (s === "RECOVERED" || s === "CONVERTED") return true;
  const o = safeStr(r.callOutcome).toLowerCase();
  return o.includes("recovered") || o.includes("converted");
}
function isAtRisk(r: Row) {
  return safeStr(r.status).toUpperCase() === "ABANDONED";
}

function urgencyScore(r: Row) {
  // higher score = show higher
  let score = 0;

  const status = safeStr(r.status).toUpperCase();
  if (status === "ABANDONED") score += 80;
  else if (status === "OPEN") score += 35;

  const callStatus = safeStr(r.callStatus).toUpperCase();
  if (callStatus === "FAILED") score += 35;
  if (!callStatus) score += 20;
  if (callStatus === "QUEUED") score += 10;
  if (callStatus === "CALLING") score += 6;

  const outcome = safeStr(r.callOutcome).toLowerCase();
  if (outcome.includes("needs_follow") || outcome.includes("follow")) score += 25;
  if (outcome.includes("voicemail") || outcome.includes("no_answer")) score += 18;
  if (outcome.includes("not_recovered") || outcome.includes("not interested")) score += 22;

  const buy = typeof r.buyProbabilityPct === "number" ? r.buyProbabilityPct : 0;
  score += Math.round(buy * 0.35);

  const val = Number(r.value || 0);
  score += Math.min(30, Math.round(val / 100));

  return score;
}

function Badge({ tone, children, label }: { tone: BadgeTone; children: React.ReactNode; label?: string }) {
  // @ts-ignore
  return <s-badge tone={tone} accessibilityLabel={label || ""}>{children}</s-badge>;
}

function clip(text: string) {
  try {
    void navigator.clipboard.writeText(text);
  } catch {}
}

function tiny(v: any) {
  const s = safeStr(v).trim();
  return s ? s : "—";
}

export default function Checkouts() {
  const { shop, rows } = useLoaderData<typeof loader>();

  const recoveredRows = React.useMemo(() => rows.filter(isRecovered), [rows]);
  const atRiskRows = React.useMemo(() => rows.filter(isAtRisk), [rows]);

  const recoveredValue = React.useMemo(
    () => sumMoney(rows, (r) => isRecovered(r)),
    [rows],
  );
  const atRiskValue = React.useMemo(
    () => sumMoney(rows, (r) => isAtRisk(r)),
    [rows],
  );

  const winRate = React.useMemo(() => pct(recoveredRows.length, Math.max(1, rows.length)), [recoveredRows.length, rows.length]);

  const latest = rows[0] ?? null;

  // prioritize active work list (exclude recovered)
  const workRows = React.useMemo(() => {
    return rows
      .filter((r) => !isRecovered(r))
      .slice()
      .sort((a, b) => urgencyScore(b) - urgencyScore(a))
      .slice(0, 80);
  }, [rows]);

  const [selectedId, setSelectedId] = React.useState<string | null>(() => {
    // default: most urgent non-recovered; fallback latest
    return workRows[0]?.checkoutId ?? latest?.checkoutId ?? null;
  });

  React.useEffect(() => {
    if (!selectedId) setSelectedId(workRows[0]?.checkoutId ?? latest?.checkoutId ?? null);
  }, [selectedId, workRows, latest]);

  // keep selection valid
  React.useEffect(() => {
    if (!selectedId) return;
    const exists = rows.some((r) => r.checkoutId === selectedId);
    if (!exists) setSelectedId(workRows[0]?.checkoutId ?? latest?.checkoutId ?? null);
  }, [selectedId, rows, workRows, latest]);

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

  const currency = (rows.find((r) => safeStr(r.currency))?.currency ?? "USD").toUpperCase();

  const recoveredRecent = React.useMemo(() => {
    return recoveredRows
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 6);
  }, [recoveredRows]);

  return (
    <>
      {/* @ts-ignore */}
      <s-page heading="Checkouts" inlineSize="large">
        {/* TOP VALUE STRIP */}
        {/* @ts-ignore */}
        <s-section>
          {/* @ts-ignore */}
          <s-grid
            gap="base"
            gridTemplateColumns="@container (inline-size < 960px) 1fr, 1.2fr 0.8fr"
          >
            {/* VALUE BOX */}
            {/* @ts-ignore */}
            <s-box border="base" borderRadius="base" padding="base" background="subdued">
              {/* @ts-ignore */}
              <s-stack gap="tight">
                {/* @ts-ignore */}
                <s-text variant="headingMd">Recovered revenue + AI call outcomes.</s-text>
                {/* @ts-ignore */}
                <s-text tone="subdued">
                  Win rate {winRate}% • {rows.length} checkouts tracked • Latest update {latest ? formatWhen(latest.updatedAt) : "—"}
                </s-text>

                {/* @ts-ignore */}
                <s-grid gap="base" gridTemplateColumns="@container (inline-size < 860px) 1fr, 1fr 1fr 1fr">
                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base">
                    {/* @ts-ignore */}
                    <s-stack gap="tight">
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">Recovered</s-text>
                      {/* @ts-ignore */}
                      <s-text variant="headingLg">{fmtMoney(recoveredValue, currency)}</s-text>
                      {/* @ts-ignore */}
                      <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                        {/* @ts-ignore */}
                        <s-badge tone="success">{recoveredRows.length} wins</s-badge>
                        {/* @ts-ignore */}
                        <s-badge tone="info">{winRate}% win</s-badge>
                      </s-stack>
                    </s-stack>
                  </s-box>

                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base">
                    {/* @ts-ignore */}
                    <s-stack gap="tight">
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">At-risk</s-text>
                      {/* @ts-ignore */}
                      <s-text variant="headingLg">{fmtMoney(atRiskValue, currency)}</s-text>
                      {/* @ts-ignore */}
                      <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                        {/* @ts-ignore */}
                        <s-badge tone="critical">{atRiskRows.length} abandoned</s-badge>
                        {/* @ts-ignore */}
                        <s-badge tone="warning">Needs action</s-badge>
                      </s-stack>
                    </s-stack>
                  </s-box>

                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base">
                    {/* @ts-ignore */}
                    <s-stack gap="tight">
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">Most recent</s-text>
                      {/* @ts-ignore */}
                      <s-text variant="headingMd">
                        {latest ? fmtMoney(Number(latest.value || 0), latest.currency) : "—"}
                      </s-text>
                      {/* @ts-ignore */}
                      <s-text tone="subdued" variant="bodySm">
                        {latest ? `${safeStr(latest.customerName) || "—"} • ${formatWhen(latest.updatedAt)}` : "—"}
                      </s-text>
                    </s-stack>
                  </s-box>
                </s-grid>
              </s-stack>
            </s-box>

            {/* RECOVERED WINS – SPECIAL BOX */}
            {/* @ts-ignore */}
            <s-box
              border="base"
              borderRadius="base"
              padding="base"
              style={{ background: "rgba(0,128,96,0.08)" }}
            >
              {/* @ts-ignore */}
              <s-stack gap="tight">
                {/* @ts-ignore */}
                <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center" }}>
                  {/* @ts-ignore */}
                  <s-text variant="headingMd">Recovered wins</s-text>
                  {/* @ts-ignore */}
                  <s-badge tone="success">{recoveredRows.length}</s-badge>
                </s-stack>

                {/* @ts-ignore */}
                <s-text tone="subdued" variant="bodySm">
                  Click a win to open full outcome details on the right.
                </s-text>

                {/* @ts-ignore */}
                <s-box border="base" borderRadius="base" style={{ overflow: "hidden", background: "rgba(255,255,255,0.7)" }}>
                  {/* @ts-ignore */}
                  <s-table style={{ tableLayout: "fixed", width: "100%" }}>
                    {/* @ts-ignore */}
                    <s-table-header-row>
                      {/* @ts-ignore */}
                      <s-table-header>Customer</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header format="numeric" style={{ width: 120 }}>Amount</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 120 }}>When</s-table-header>
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
                                  {safeStr(r.callOutcome) ? safeStr(r.callOutcome).toUpperCase() : "RECOVERED"}
                                </s-text>
                              </s-table-cell>
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>{fmtMoney(Number(r.value || 0), r.currency)}</s-table-cell>
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>{formatWhen(r.updatedAt)}</s-table-cell>
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
          <s-grid
            gap="base"
            gridTemplateColumns="@container (inline-size < 1100px) 1fr, 1.15fr 0.85fr"
          >
            {/* LEFT: ACTION QUEUE (AT-RISK + OPEN + FAILED) */}
            {/* @ts-ignore */}
            <s-section>
              {/* @ts-ignore */}
              <s-stack gap="tight">
                {/* @ts-ignore */}
                <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center", flexWrap: "wrap" }}>
                  {/* @ts-ignore */}
                  <s-text variant="headingMd">Action queue</s-text>
                  {/* @ts-ignore */}
                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                    {/* @ts-ignore */}
                    <s-badge tone="critical">{atRiskRows.length} abandoned</s-badge>
                    {/* @ts-ignore */}
                    <s-badge tone="info">{workRows.length} to review</s-badge>
                    {/* @ts-ignore */}
                    <s-badge tone="new">Sorted by urgency</s-badge>
                  </s-stack>
                </s-stack>

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
                      <s-table-header style={{ width: 190 }}>Signals</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 260 }}>Next step</s-table-header>
                    </s-table-header-row>

                    {/* @ts-ignore */}
                    <s-table-body>
                      {workRows.length === 0 ? (
                        // @ts-ignore
                        <s-table-row>
                          {/* @ts-ignore */}
                          <s-table-cell colSpan={5}>
                            {/* @ts-ignore */}
                            <s-text tone="subdued">Nothing to work right now.</s-text>
                          </s-table-cell>
                        </s-table-row>
                      ) : (
                        workRows.map((r) => {
                          const isSel = r.checkoutId === selectedId;
                          const id = r.checkoutId;

                          const checkoutTone = toneForCheckoutStatus(r.status);
                          const callTone = r.callStatus ? toneForJobStatus(r.callStatus) : "neutral";
                          const outcomeTone = toneForOutcome(r.callOutcome);

                          const customer = safeStr(r.customerName) || "—";
                          const phone = safeStr(r.phone);
                          const cartLine = safeStr(r.cartPreview);

                          const nba = safeStr(r.nextBestAction);
                          const nbaText = nba ? nba : "—";

                          return (
                            // @ts-ignore
                            <s-table-row
                              key={id}
                              clickDelegate={`open-${id}`}
                              style={isSel ? { background: "var(--p-color-bg-surface-secondary)" } : undefined}
                            >
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                <div style={{ width: 44, height: 44 }}>
                                  {/* @ts-ignore */}
                                  <s-thumbnail
                                    src={r.thumbUrl || undefined}
                                    alt={r.thumbUrl ? "Item" : "No image"}
                                    size="small-200"
                                  />
                                </div>
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
                                    {phone ? (
                                      // @ts-ignore
                                      <s-text tone="subdued" variant="bodySm">{phone}</s-text>
                                    ) : null}
                                    {/* @ts-ignore */}
                                    <s-text tone="subdued" variant="bodySm">#{id}</s-text>
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
                                  <s-badge tone={outcomeTone}>{r.callOutcome ? safeStr(r.callOutcome).toUpperCase() : "—"}</s-badge>
                                  {/* @ts-ignore */}
                                  <s-badge tone="info">{r.buyProbabilityPct == null ? "Buy —" : `Buy ${r.buyProbabilityPct}%`}</s-badge>
                                </s-stack>
                              </s-table-cell>

                              {/* @ts-ignore */}
                              <s-table-cell style={compactCell}>
                                {/* @ts-ignore */}
                                <s-stack gap="tight">
                                  {/* @ts-ignore */}
                                  <s-text
                                    tone={nbaText === "—" ? "subdued" : "base"}
                                    style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                    title={nbaText}
                                  >
                                    {nbaText}
                                  </s-text>

                                  {/* @ts-ignore */}
                                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                                    {/* @ts-ignore */}
                                    <s-button
                                      variant="secondary"
                                      onClick={() => setSelectedId(id)}
                                    >
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
            <div style={{ position: "sticky", top: 16, alignSelf: "start" }}>
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
                        {/* Status chips */}
                        {/* @ts-ignore */}
                        <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                          {/* @ts-ignore */}
                          <s-badge tone={toneForCheckoutStatus(details?.checkout?.status ?? selected.status)}>
                            {safeStr(details?.checkout?.status ?? selected.status).toUpperCase()}
                          </s-badge>

                          {details?.latestJob?.status ? (
                            // @ts-ignore
                            <s-badge tone={toneForJobStatus(details.latestJob.status)}>{safeStr(details.latestJob.status).toUpperCase()}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">NO JOB</s-badge>
                          )}

                          {sb?.call_outcome ? (
                            // @ts-ignore
                            <s-badge tone={toneForOutcome(sb.call_outcome)}>{safeStr(sb.call_outcome).toUpperCase()}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">OUTCOME —</s-badge>
                          )}

                          {sb?.ai_status ? (
                            // @ts-ignore
                            <s-badge tone="info">{`AI ${safeStr(sb.ai_status).toUpperCase()}`}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">AI —</s-badge>
                          )}

                          {typeof sb?.buy_probability === "number" ? (
                            // @ts-ignore
                            <s-badge tone="info">{`Buy ${Math.round(sb.buy_probability)}%`}</s-badge>
                          ) : (
                            // @ts-ignore
                            <s-badge tone="neutral">Buy —</s-badge>
                          )}

                          {sb?.answered != null ? (
                            // @ts-ignore
                            <s-badge tone="new">{`Answered ${String(sb.answered)}`}</s-badge>
                          ) : null}
                          {sb?.voicemail != null ? (
                            // @ts-ignore
                            <s-badge tone="new">{`Voicemail ${String(sb.voicemail)}`}</s-badge>
                          ) : null}
                        </s-stack>

                        {/* Customer + money */}
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
                                {fmtMoney(Number(details?.checkout?.value ?? selected.value ?? 0), String(details?.checkout?.currency ?? selected.currency))}
                              </s-text>
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">Updated {formatWhen(details?.checkout?.updatedAt ?? selected.updatedAt)}</s-text>
                              {/* @ts-ignore */}
                              <s-text tone="subdued" variant="bodySm">
                                Abandoned {details?.checkout?.abandonedAt ? formatWhen(details.checkout.abandonedAt) : "—"}
                              </s-text>
                            </s-stack>
                          </s-grid>
                        </s-box>

                        {/* Primary actions */}
                        {/* @ts-ignore */}
                        <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                          {/* @ts-ignore */}
                          <s-button
                            variant="primary"
                            disabled={!(details?.recordingUrl ?? selected.recordingUrl)}
                            onClick={() => {
                              const url = details?.recordingUrl ?? selected.recordingUrl;
                              if (url) window.open(url, "_blank", "noreferrer");
                            }}
                          >
                            Recording
                          </s-button>

                          {/* @ts-ignore */}
                          <s-button
                            variant="secondary"
                            disabled={!safeStr(sb?.log_url).trim()}
                            onClick={() => {
                              const url = safeStr(sb?.log_url).trim();
                              if (url) window.open(url, "_blank", "noreferrer");
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

                        {/* Next best action – focus block */}
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
                            <s-text>{safeStr(sb?.next_best_action || sb?.best_next_action) || selected.nextBestAction || "—"}</s-text>
                          </s-stack>
                        </s-box>

                        {/* Follow-up message – copyable */}
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

                        {/* Signals (use ALL outcome signals that exist) */}
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

                        {/* Items */}
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
                                        <div style={{ width: 44, height: 44 }}>
                                          {/* @ts-ignore */}
                                          <s-thumbnail src={img || undefined} alt={img ? title : "No image"} size="small-200" />
                                        </div>
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
            </div>
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
          // show ALL the useful outcome fields, but in a readable grid/table
          // key quotes, objections, issues, tags, summary, next action
          // (kept in modal so the page doesn’t grow vertically)
          // @ts-ignore
          <s-stack gap="base">
            {/* @ts-ignore */}
            <s-box border="base" borderRadius="base" padding="base">
              {/* @ts-ignore */}
              <s-text variant="headingSm">Summary</s-text>
              {/* @ts-ignore */}
              <s-text tone="subdued">{safeStr(sb?.summary_clean || sb?.summary) || "—"}</s-text>
            </s-box>

            {/* @ts-ignore */}
            <s-box border="base" borderRadius="base" padding="base">
              {/* @ts-ignore */}
              <s-text variant="headingSm">Next best action</s-text>
              {/* @ts-ignore */}
              <s-text tone="subdued">{safeStr(sb?.next_best_action || sb?.best_next_action) || "—"}</s-text>
            </s-box>

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
                <pre style={mono}>{safeStr(sb?.tagcsv || (Array.isArray(sb?.tags) ? sb.tags.join(", ") : "")) || "—"}</pre>
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