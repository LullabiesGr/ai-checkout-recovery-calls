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
  updatedAt: string;
  abandonedAt: string | null;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  value: number;
  currency: string;

  itemsJson: any; // keep raw so we can render thumbnails in UI
  cartPreview: string | null;
  thumbUrl: string | null;
  itemsCount: number;

  callStatus: string | null;
  callOutcome: string | null;
  aiStatus: string | null;
  buyProbabilityPct: number | null;
  recordingUrl: string | null;
  logUrl: string | null;

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

  // common shapes:
  // { items: [...] } or { lineItems: [...] } or { cart: { items: [...] } }
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

      latestJobId: j?.id ? String(j.id) : null,
      latestProviderCallId: j?.providerCallId ? String(j.providerCallId) : null,
    };
  });

  return { shop, rows } satisfies LoaderData;
};

/* ---------------- Money helpers ---------------- */
function sumMoney(rows: Row[], pred: (r: Row) => boolean) {
  let n = 0;
  for (const r of rows) if (pred(r)) n += Number(r.value || 0);
  return n;
}

/* ---------------- UI helpers (minimal) ---------------- */
function Badge({ tone, children, label }: { tone: BadgeTone; children: React.ReactNode; label?: string }) {
  return (
    // @ts-ignore - custom element
    <s-badge tone={tone} accessibilityLabel={label || ""}>
      {children}
    </s-badge>
  );
}

function MonoPre({ value }: { value: any }) {
  const text =
    value == null
      ? ""
      : typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();

  return (
    // @ts-ignore - custom element
    <s-box padding="base" background="subdued" border="base" borderRadius="base">
      <pre
        style={{
          margin: 0,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 12,
          fontWeight: 650,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text || "—"}
      </pre>
    </s-box>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    // @ts-ignore - custom element
    <s-stack gap="small-100">
      {/* @ts-ignore */}
      <s-text tone="subdued" variant="bodySm">
        {label}
      </s-text>
      {/* @ts-ignore */}
      <s-text variant="bodyMd" fontWeight="semibold">
        {value}
      </s-text>
    </s-stack>
  );
}

/* ---------------- Page ---------------- */
// REPLACE ONLY THE UI PART: export default function Checkouts() { ... }  (keep your loader/helpers as-is)

export default function Checkouts() {
  const { shop, rows } = useLoaderData<typeof loader>();

  /* ---------------- Filters ---------------- */
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"ALL" | "ABANDONED" | "OPEN" | "RECOVERED">("ALL");
  const [callFilter, setCallFilter] = React.useState<"ALL" | "NO_CALL" | "QUEUED" | "CALLING" | "COMPLETED" | "FAILED">(
    "ALL",
  );
  const [outcomeFilter, setOutcomeFilter] = React.useState<"ALL" | "NO_ANSWER" | "VOICEMAIL" | "NEEDS_FOLLOW" | "NOT_RECOVERED" | "RECOVERED">(
    "ALL",
  );
  const [buyMin, setBuyMin] = React.useState<"ALL" | "30" | "50" | "70">("ALL");

  const q = query.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    const norm = (v: any) => safeStr(v).toLowerCase();

    const matchOutcome = (raw: string | null) => {
      const s = norm(raw);
      if (outcomeFilter === "ALL") return true;
      if (outcomeFilter === "NO_ANSWER") return s.includes("no_answer");
      if (outcomeFilter === "VOICEMAIL") return s.includes("voicemail");
      if (outcomeFilter === "NEEDS_FOLLOW") return s.includes("follow");
      if (outcomeFilter === "NOT_RECOVERED") return s.includes("not_recovered") || s.includes("not interested");
      if (outcomeFilter === "RECOVERED") return s.includes("recovered") || s.includes("converted");
      return true;
    };

    const matchCheckoutStatus = (raw: string) => {
      const s = safeStr(raw).toUpperCase();
      if (statusFilter === "ALL") return true;
      if (statusFilter === "RECOVERED") return s === "RECOVERED" || s === "CONVERTED";
      return s === statusFilter;
    };

    const matchCallStatus = (raw: string | null) => {
      const s = safeStr(raw).toUpperCase();
      if (callFilter === "ALL") return true;
      if (callFilter === "NO_CALL") return !s;
      return s === callFilter;
    };

    const matchBuy = (buyProbabilityPct: number | null) => {
      if (buyMin === "ALL") return true;
      const min = Number(buyMin);
      const v = typeof buyProbabilityPct === "number" ? buyProbabilityPct : -1;
      return v >= min;
    };

    return rows.filter((c) => {
      if (!matchCheckoutStatus(c.status)) return false;
      if (!matchCallStatus(c.callStatus)) return false;
      if (!matchOutcome(c.callOutcome)) return false;
      if (!matchBuy(c.buyProbabilityPct)) return false;

      if (!q) return true;
      return (
        norm(c.checkoutId).includes(q) ||
        norm(c.customerName).includes(q) ||
        norm(c.phone).includes(q) ||
        norm(c.email).includes(q) ||
        norm(c.cartPreview).includes(q) ||
        norm(c.status).includes(q) ||
        norm(c.callStatus).includes(q) ||
        norm(c.callOutcome).includes(q) ||
        norm(c.aiStatus).includes(q)
      );
    });
  }, [rows, q, statusFilter, callFilter, outcomeFilter, buyMin]);

  const [selectedId, setSelectedId] = React.useState<string | null>(filtered?.[0]?.checkoutId ?? null);

  React.useEffect(() => {
    if (!selectedId && filtered?.[0]?.checkoutId) setSelectedId(filtered[0].checkoutId);
  }, [selectedId, filtered]);

  React.useEffect(() => {
    if (selectedId && !filtered.some((r) => r.checkoutId === selectedId)) {
      setSelectedId(filtered?.[0]?.checkoutId ?? null);
    }
  }, [selectedId, filtered]);

  const selected = React.useMemo(() => filtered.find((r) => r.checkoutId === selectedId) ?? null, [filtered, selectedId]);

  /* ---------------- Details fetch (right panel) ---------------- */
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

  /* ---------------- Stats ---------------- */
  const stats = React.useMemo(() => {
    const total = filtered.length;
    const abandonedCount = filtered.filter((r) => safeStr(r.status).toUpperCase() === "ABANDONED").length;
    const openCount = filtered.filter((r) => safeStr(r.status).toUpperCase() === "OPEN").length;
    const recoveredCount = filtered.filter((r) => {
      const s = safeStr(r.status).toUpperCase();
      return s === "RECOVERED" || s === "CONVERTED";
    }).length;

    const atRisk = sumMoney(filtered, (r) => safeStr(r.status).toUpperCase() === "ABANDONED");
    const recovered = sumMoney(filtered, (r) => {
      const s = safeStr(r.status).toUpperCase();
      return s === "RECOVERED" || s === "CONVERTED";
    });

    return { total, abandonedCount, openCount, recoveredCount, atRisk, recovered };
  }, [filtered]);

  /* ---------------- Popovers (no “open down the page”) ---------------- */
  const [openPopoverId, setOpenPopoverId] = React.useState<string | null>(null);
  const [openPopoverKind, setOpenPopoverKind] = React.useState<"ai" | "raw" | "transcript">("ai");
  const isPopoverOpen = (id: string, kind: typeof openPopoverKind) => openPopoverId === `${kind}:${id}`;
  const openPopover = (id: string, kind: typeof openPopoverKind) => setOpenPopoverId(`${kind}:${id}`);
  const closePopover = () => setOpenPopoverId(null);

  /* ---------------- Compact layout styles ---------------- */
  const compactCellStyle: React.CSSProperties = { paddingTop: 6, paddingBottom: 6, verticalAlign: "top" };
  const monoSmall: React.CSSProperties = {
    margin: 0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12,
    fontWeight: 650,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  return (
    <>
      {/* @ts-ignore */}
      <s-page heading="Checkouts" inlineSize="large">
        {/* @ts-ignore */}
        <s-section>
          {/* @ts-ignore */}
          <s-stack gap="base">
            {/* VALUE + STATS */}
            {/* @ts-ignore */}
            <s-box padding="base" border="base" borderRadius="base" background="subdued">
              {/* @ts-ignore */}
              <s-stack gap="small-100">
                {/* @ts-ignore */}
                <s-text variant="headingMd">Actionable checkouts: AI outcome + next best action, side-by-side.</s-text>
                {/* @ts-ignore */}
                <s-stack direction="inline" gap="small-100" wrap>
                  {/* @ts-ignore */}
                  <s-badge tone="info">{stats.total} rows</s-badge>
                  {/* @ts-ignore */}
                  <s-badge tone="critical">Abandoned {stats.abandonedCount}</s-badge>
                  {/* @ts-ignore */}
                  <s-badge tone="warning">Open {stats.openCount}</s-badge>
                  {/* @ts-ignore */}
                  <s-badge tone="success">Recovered {stats.recoveredCount}</s-badge>
                  {/* @ts-ignore */}
                  <s-badge tone="warning">At-risk {stats.atRisk.toFixed(2)}</s-badge>
                  {/* @ts-ignore */}
                  <s-badge tone="success">Recovered {stats.recovered.toFixed(2)}</s-badge>
                </s-stack>
              </s-stack>
            </s-box>

            {/* FILTER BAR (no horizontal scroll, wraps) */}
            {/* @ts-ignore */}
            <s-box padding="base" border="base" borderRadius="base">
              {/* @ts-ignore */}
              <s-grid columns="minmax(240px, 1.4fr) repeat(4, minmax(160px, 1fr))" gap="base" alignItems="end">
                {/* @ts-ignore */}
                <s-text-field
                  label="Search"
                  value={query}
                  placeholder="Customer, phone, email, cart, AI…"
                  clearButton
                  onInput={(e: any) => setQuery(String(e.currentTarget?.value ?? ""))}
                  onClearButtonClick={() => setQuery("")}
                />

                {/* @ts-ignore */}
                <s-select
                  label="Checkout status"
                  value={statusFilter}
                  onChange={(e: any) => setStatusFilter(String(e.currentTarget?.value ?? "ALL") as any)}
                >
                  <option value="ALL">All</option>
                  <option value="ABANDONED">Abandoned</option>
                  <option value="OPEN">Open</option>
                  <option value="RECOVERED">Recovered/Converted</option>
                </s-select>

                {/* @ts-ignore */}
                <s-select
                  label="Call status"
                  value={callFilter}
                  onChange={(e: any) => setCallFilter(String(e.currentTarget?.value ?? "ALL") as any)}
                >
                  <option value="ALL">All</option>
                  <option value="NO_CALL">No call</option>
                  <option value="QUEUED">Queued</option>
                  <option value="CALLING">Calling</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="FAILED">Failed</option>
                </s-select>

                {/* @ts-ignore */}
                <s-select
                  label="Outcome"
                  value={outcomeFilter}
                  onChange={(e: any) => setOutcomeFilter(String(e.currentTarget?.value ?? "ALL") as any)}
                >
                  <option value="ALL">All</option>
                  <option value="NO_ANSWER">No answer</option>
                  <option value="VOICEMAIL">Voicemail</option>
                  <option value="NEEDS_FOLLOW">Needs follow-up</option>
                  <option value="NOT_RECOVERED">Not recovered</option>
                  <option value="RECOVERED">Recovered</option>
                </s-select>

                {/* @ts-ignore */}
                <s-select label="Buy ≥" value={buyMin} onChange={(e: any) => setBuyMin(String(e.currentTarget?.value ?? "ALL") as any)}>
                  <option value="ALL">All</option>
                  <option value="30">30%</option>
                  <option value="50">50%</option>
                  <option value="70">70%</option>
                </s-select>
              </s-grid>

              {/* optional: keep datepicker slot ready without breaking layout */}
              {/* @ts-ignore */}
              <s-text tone="subdued" variant="bodySm">
                Tip: add Datepicker later by filtering on updatedAt/abandonedAt (client-side) without touching loader.
              </s-text>
            </s-box>

            {/* MAIN GRID (always side-by-side; wraps to 1 column on small via CSS) */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(520px, 1fr) minmax(520px, 1fr)",
                gap: 16,
              }}
            >
              {/* LEFT: COMPACT TABLE LIST */}
              {/* @ts-ignore */}
              <s-section heading="Latest checkouts">
                {/* @ts-ignore */}
                <s-box border="base" borderRadius="base" style={{ overflow: "hidden" }}>
                  {/* @ts-ignore */}
                  <s-table style={{ tableLayout: "fixed", width: "100%" }}>
                    {/* @ts-ignore */}
                    <s-table-header-row>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 60 }}>Item</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header>Customer / Cart</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 110 }} format="numeric">
                        Value
                      </s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 180 }}>Status</s-table-header>
                      {/* @ts-ignore */}
                      <s-table-header style={{ width: 150 }}>AI</s-table-header>
                    </s-table-header-row>

                    {/* @ts-ignore */}
                    <s-table-body>
                      {filtered.length === 0 ? (
                        // @ts-ignore
                        <s-table-row>
                          {/* @ts-ignore */}
                          <s-table-cell colSpan={5}>
                            {/* @ts-ignore */}
                            <s-text tone="subdued">No results.</s-text>
                          </s-table-cell>
                        </s-table-row>
                      ) : (
                        filtered.map((c) => {
                          const isSel = c.checkoutId === selectedId;

                          const checkoutTone = toneForCheckoutStatus(c.status);
                          const callTone = c.callStatus ? toneForJobStatus(c.callStatus) : "neutral";
                          const outcomeTone = toneForOutcome(c.callOutcome);

                          const customer = safeStr(c.customerName) || "—";
                          const phone = safeStr(c.phone);
                          const cartLine = safeStr(c.cartPreview);
                          const updatedText = formatWhen(c.updatedAt);

                          const rowId = c.checkoutId;

                          return (
                            // @ts-ignore
                            <s-table-row
                              key={rowId}
                              clickDelegate={`open-${rowId}`}
                              style={isSel ? { background: "var(--p-color-bg-surface-secondary)" } : undefined}
                            >
                              {/* THUMB */}
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCellStyle}>
                                <div style={{ width: 44, height: 44 }}>
                                  {/* @ts-ignore */}
                                  <s-thumbnail
                                    src={c.thumbUrl || undefined}
                                    alt={c.thumbUrl ? "Cart item preview" : "No image"}
                                    size="small-200"
                                  />
                                </div>
                              </s-table-cell>

                              {/* CUSTOMER / CART */}
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCellStyle}>
                                {/* @ts-ignore */}
                                <s-stack gap="small-100">
                                  {/* @ts-ignore */}
                                  <s-stack direction="inline" gap="small-100" wrap alignItems="center">
                                    {/* @ts-ignore */}
                                    <s-link id={`open-${rowId}`} href="#"
                                      onClick={(e: any) => {
                                        e.preventDefault();
                                        setSelectedId(rowId);
                                      }}
                                    >
                                      {/* @ts-ignore */}
                                      <s-text fontWeight="semibold">{customer}</s-text>
                                    </s-link>
                                    {phone ? (
                                      // @ts-ignore
                                      <s-text tone="subdued" variant="bodySm">
                                        {phone}
                                      </s-text>
                                    ) : null}
                                    {/* @ts-ignore */}
                                    <s-text tone="subdued" variant="bodySm">
                                      #{rowId}
                                    </s-text>
                                  </s-stack>

                                  {/* @ts-ignore */}
                                  <s-text tone="subdued" variant="bodySm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {cartLine || "—"}
                                  </s-text>

                                  {/* @ts-ignore */}
                                  <s-text tone="subdued" variant="bodySm">
                                    Updated {updatedText}
                                  </s-text>
                                </s-stack>
                              </s-table-cell>

                              {/* VALUE */}
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCellStyle}>
                                {/* @ts-ignore */}
                                <s-text fontWeight="semibold">
                                  {Number(c.value || 0).toFixed(2)} {safeStr(c.currency)}
                                </s-text>
                                {/* @ts-ignore */}
                                <s-text tone="subdued" variant="bodySm">
                                  {c.itemsCount ? `${c.itemsCount} items` : "0 items"}
                                </s-text>
                              </s-table-cell>

                              {/* STATUS (compact badges) */}
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCellStyle}>
                                {/* @ts-ignore */}
                                <s-stack direction="inline" gap="small-100" wrap>
                                  {/* @ts-ignore */}
                                  <s-badge tone={checkoutTone}>{safeStr(c.status).toUpperCase()}</s-badge>
                                  {/* @ts-ignore */}
                                  <s-badge tone={callTone}>{c.callStatus ? safeStr(c.callStatus).toUpperCase() : "NO CALL"}</s-badge>
                                  {/* @ts-ignore */}
                                  <s-badge tone={outcomeTone}>{c.callOutcome ? safeStr(c.callOutcome).toUpperCase() : "—"}</s-badge>
                                </s-stack>
                              </s-table-cell>

                              {/* AI (popover, no vertical expansion) */}
                              {/* @ts-ignore */}
                              <s-table-cell style={compactCellStyle}>
                                {/* @ts-ignore */}
                                <s-stack gap="small-100">
                                  {/* @ts-ignore */}
                                  <s-badge tone="info">{c.buyProbabilityPct == null ? "Buy —" : `Buy ${c.buyProbabilityPct}%`}</s-badge>

                                  {/* @ts-ignore */}
                                  <s-popover
                                    active={isPopoverOpen(rowId, "ai")}
                                    onClose={closePopover}
                                    placement="bottom"
                                    activator={
                                      // @ts-ignore
                                      <s-button
                                        variant="tertiary"
                                        onClick={(e: any) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          openPopover(rowId, "ai");
                                        }}
                                      >
                                        AI preview
                                      </s-button>
                                    }
                                  >
                                    {/* @ts-ignore */}
                                    <s-box padding="base" style={{ maxWidth: 420 }}>
                                      {/* @ts-ignore */}
                                      <s-stack gap="base">
                                        {/* @ts-ignore */}
                                        <s-text variant="headingSm">Next best action</s-text>
                                        {/* @ts-ignore */}
                                        <s-text tone="subdued">{safeStr((details?.checkout?.checkoutId === rowId ? details?.sb?.next_best_action : null) || "") || "Open row to load full AI fields."}</s-text>

                                        {/* @ts-ignore */}
                                        <s-text variant="headingSm">Quick links</s-text>
                                        {/* @ts-ignore */}
                                        <s-stack direction="inline" gap="small-100" wrap>
                                          {/* @ts-ignore */}
                                          <s-button
                                            variant="secondary"
                                            onClick={() => {
                                              setSelectedId(rowId);
                                            }}
                                          >
                                            Open details
                                          </s-button>
                                        </s-stack>
                                      </s-stack>
                                    </s-box>
                                  </s-popover>
                                </s-stack>
                              </s-table-cell>
                            </s-table-row>
                          );
                        })
                      )}
                    </s-table-body>
                  </s-table>
                </s-box>
              </s-section>

              {/* RIGHT: STICKY DETAILS PANEL (never opens under the table) */}
              <div style={{ position: "sticky", top: 16, alignSelf: "start" }}>
                {/* @ts-ignore */}
                <s-section heading="Details">
                  {/* @ts-ignore */}
                  <s-box border="base" borderRadius="base" padding="base">
                    {/* @ts-ignore */}
                    <s-stack gap="base">
                      {/* header */}
                      {/* @ts-ignore */}
                      <s-grid columns="1fr auto" gap="base" alignItems="center">
                        {/* @ts-ignore */}
                        <s-stack gap="small-100">
                          {/* @ts-ignore */}
                          <s-text tone="subdued" variant="bodySm">
                            {selected ? `Checkout #${selected.checkoutId}` : "Select a checkout"}
                          </s-text>
                        </s-stack>
                        {loadingDetails ? (
                          // @ts-ignore
                          <s-spinner size="small" />
                        ) : null}
                      </s-grid>

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
                          {/* badges */}
                          {/* @ts-ignore */}
                          <s-stack direction="inline" gap="small-100" wrap>
                            {/* @ts-ignore */}
                            <s-badge tone={toneForCheckoutStatus(details?.checkout?.status ?? selected.status)}>
                              {safeStr(details?.checkout?.status ?? selected.status).toUpperCase()}
                            </s-badge>

                            {details?.latestJob?.status ? (
                              // @ts-ignore
                              <s-badge tone={toneForJobStatus(details.latestJob.status)}>{safeStr(details.latestJob.status).toUpperCase()}</s-badge>
                            ) : null}

                            {sb?.call_outcome ? (
                              // @ts-ignore
                              <s-badge tone={toneForOutcome(sb.call_outcome)}>{safeStr(sb.call_outcome).toUpperCase()}</s-badge>
                            ) : null}

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
                          </s-stack>

                          {/* info grid */}
                          {/* @ts-ignore */}
                          <s-box padding="base" background="subdued" borderRadius="base">
                            {/* @ts-ignore */}
                            <s-stack gap="base">
                              {/* @ts-ignore */}
                              <s-grid columns="repeat(3, minmax(0, 1fr))" gap="base" alignItems="start">
                                <Field label="Customer" value={details?.checkout?.customerName ?? selected.customerName ?? "—"} />
                                <Field label="Phone" value={details?.checkout?.phone ?? selected.phone ?? "—"} />
                                <Field label="Email" value={details?.checkout?.email ?? selected.email ?? "—"} />
                              </s-grid>

                              {/* @ts-ignore */}
                              <s-grid columns="repeat(3, minmax(0, 1fr))" gap="base" alignItems="start">
                                <Field
                                  label="Cart total"
                                  value={`${safeStr(details?.checkout?.value ?? selected.value)} ${safeStr(details?.checkout?.currency ?? selected.currency)}`}
                                />
                                <Field label="Updated" value={formatWhen(details?.checkout?.updatedAt ?? selected.updatedAt)} />
                                <Field label="Abandoned" value={details?.checkout?.abandonedAt ? formatWhen(details.checkout.abandonedAt) : "—"} />
                              </s-grid>
                            </s-stack>
                          </s-box>

                          {/* primary actions */}
                          {/* @ts-ignore */}
                          <s-stack direction="inline" gap="small-100" wrap>
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

                            {/* Transcript popover */}
                            {/* @ts-ignore */}
                            <s-popover
                              active={isPopoverOpen(selected.checkoutId, "transcript")}
                              onClose={closePopover}
                              placement="bottom"
                              activator={
                                // @ts-ignore
                                <s-button
                                  variant="secondary"
                                  disabled={!safeStr(sb?.transcript).trim()}
                                  onClick={() => openPopover(selected.checkoutId, "transcript")}
                                >
                                  Transcript
                                </s-button>
                              }
                            >
                              {/* @ts-ignore */}
                              <s-box padding="base" style={{ width: 520, maxWidth: "80vw" }}>
                                <pre style={monoSmall}>{safeStr(sb?.transcript) || "—"}</pre>
                              </s-box>
                            </s-popover>

                            {/* Raw popover */}
                            {/* @ts-ignore */}
                            <s-popover
                              active={isPopoverOpen(selected.checkoutId, "raw")}
                              onClose={closePopover}
                              placement="bottom"
                              activator={
                                // @ts-ignore
                                <s-button variant="secondary" onClick={() => openPopover(selected.checkoutId, "raw")}>
                                  Raw
                                </s-button>
                              }
                            >
                              {/* @ts-ignore */}
                              <s-box padding="base" style={{ width: 520, maxWidth: "80vw" }}>
                                <pre style={monoSmall}>
                                  {(() => {
                                    try {
                                      return JSON.stringify(
                                        {
                                          end_of_call_report: sb?.end_of_call_report ?? null,
                                          ai_result: sb?.ai_result ?? null,
                                          structured_outputs: sb?.structured_outputs ?? null,
                                          payload: sb?.payload ?? null,
                                          checkout_raw: details?.checkout?.raw ?? null,
                                        },
                                        null,
                                        2,
                                      );
                                    } catch {
                                      return "—";
                                    }
                                  })()}
                                </pre>
                              </s-box>
                            </s-popover>
                          </s-stack>

                          {/* AI summary + NBA as compact grid blocks */}
                          {/* @ts-ignore */}
                          <s-grid columns="1fr" gap="base" alignItems="start">
                            {/* @ts-ignore */}
                            <s-box border="base" borderRadius="base" padding="base">
                              {/* @ts-ignore */}
                              <s-stack gap="small-100">
                                {/* @ts-ignore */}
                                <s-text variant="headingSm">Summary</s-text>
                                {/* @ts-ignore */}
                                <s-text tone="subdued">{safeStr(sb?.summary_clean || sb?.summary) || "—"}</s-text>
                              </s-stack>
                            </s-box>

                            {/* @ts-ignore */}
                            <s-box border="base" borderRadius="base" padding="base">
                              {/* @ts-ignore */}
                              <s-stack gap="small-100">
                                {/* @ts-ignore */}
                                <s-text variant="headingSm">Next best action</s-text>
                                {/* @ts-ignore */}
                                <s-text tone="subdued">{safeStr(sb?.next_best_action || sb?.best_next_action) || "—"}</s-text>
                              </s-stack>
                            </s-box>

                            {/* @ts-ignore */}
                            <s-box border="base" borderRadius="base" padding="base">
                              {/* @ts-ignore */}
                              <s-stack gap="small-100">
                                {/* @ts-ignore */}
                                <s-text variant="headingSm">Follow-up message</s-text>
                                <pre style={monoSmall}>{safeStr(sb?.follow_up_message) || "—"}</pre>
                              </s-stack>
                            </s-box>
                          </s-grid>

                          {/* Items (compact, no huge rows) */}
                          {/* @ts-ignore */}
                          <s-section heading="Items">
                            {/* @ts-ignore */}
                            <s-box border="base" borderRadius="base" style={{ overflow: "hidden" }}>
                              {/* @ts-ignore */}
                              <s-table style={{ tableLayout: "fixed", width: "100%" }}>
                                {/* @ts-ignore */}
                                <s-table-header-row>
                                  {/* @ts-ignore */}
                                  <s-table-header style={{ width: 60 }}>Img</s-table-header>
                                  {/* @ts-ignore */}
                                  <s-table-header>Title</s-table-header>
                                  {/* @ts-ignore */}
                                  <s-table-header style={{ width: 90 }} format="numeric">
                                    Qty
                                  </s-table-header>
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
                                    itemsForDetails.slice(0, 25).map((it, idx) => {
                                      const title = safeStr(it.title || it.name) || "Item";
                                      const qtyRaw = it.quantity ?? it.qty ?? "";
                                      const qty = safeStr(qtyRaw) || "—";
                                      const img = pickThumbFromItem(it);

                                      return (
                                        // @ts-ignore
                                        <s-table-row key={`${title}-${idx}`}>
                                          {/* @ts-ignore */}
                                          <s-table-cell style={compactCellStyle}>
                                            <div style={{ width: 44, height: 44 }}>
                                              {/* @ts-ignore */}
                                              <s-thumbnail
                                                src={img || undefined}
                                                alt={img ? `Preview of ${title}` : "No image"}
                                                size="small-200"
                                              />
                                            </div>
                                          </s-table-cell>
                                          {/* @ts-ignore */}
                                          <s-table-cell style={compactCellStyle}>
                                            {/* @ts-ignore */}
                                            <s-text fontWeight="semibold">{title}</s-text>
                                            {safeStr(it.variantTitle) ? (
                                              // @ts-ignore
                                              <s-text tone="subdued" variant="bodySm">
                                                {safeStr(it.variantTitle)}
                                              </s-text>
                                            ) : null}
                                          </s-table-cell>
                                          {/* @ts-ignore */}
                                          <s-table-cell style={compactCellStyle}>{qty}</s-table-cell>
                                        </s-table-row>
                                      );
                                    })
                                  )}
                                </s-table-body>
                              </s-table>
                            </s-box>
                          </s-section>
                        </s-stack>
                      )}
                    </s-stack>
                  </s-box>
                </s-section>
              </div>
            </div>

            {/* responsive: collapse to 1 column on small screens without horizontal scroll */}
            <style>{`
              @media (max-width: 1140px) {
                ._checkoutsGridFix { grid-template-columns: 1fr !important; }
              }
            `}</style>
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);