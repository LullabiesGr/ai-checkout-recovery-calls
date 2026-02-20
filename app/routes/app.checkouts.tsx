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
export default function Checkouts() {
  const { shop, rows } = useLoaderData<typeof loader>();

  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    if (!q) return rows;
    return rows.filter((c) => {
      return (
        safeStr(c.checkoutId).toLowerCase().includes(q) ||
        safeStr(c.customerName).toLowerCase().includes(q) ||
        safeStr(c.cartPreview).toLowerCase().includes(q) ||
        safeStr(c.status).toLowerCase().includes(q) ||
        safeStr(c.phone).toLowerCase().includes(q) ||
        safeStr(c.email).toLowerCase().includes(q) ||
        safeStr(c.callStatus).toLowerCase().includes(q) ||
        safeStr(c.callOutcome).toLowerCase().includes(q) ||
        safeStr(c.aiStatus).toLowerCase().includes(q)
      );
    });
  }, [rows, q]);

  const [selectedId, setSelectedId] = React.useState<string | null>(filtered?.[0]?.checkoutId ?? null);

  React.useEffect(() => {
    if (!selectedId && filtered?.[0]?.checkoutId) setSelectedId(filtered[0].checkoutId);
  }, [selectedId, filtered]);

  React.useEffect(() => {
    if (selectedId && !filtered.some((r) => r.checkoutId === selectedId)) {
      setSelectedId(filtered?.[0]?.checkoutId ?? null);
    }
  }, [selectedId, filtered]);

  const selected = React.useMemo(
    () => filtered.find((r) => r.checkoutId === selectedId) ?? null,
    [filtered, selectedId],
  );

  const detailsFetcher = useFetcher<any>();
  React.useEffect(() => {
    if (!selected?.checkoutId) return;
    detailsFetcher.load(withSearch(`/app/checkouts/${encodeURIComponent(selected.checkoutId)}`));
  }, [selected?.checkoutId]);

  const details = detailsFetcher.data?.shop ? detailsFetcher.data : null;
  const sb = details?.sb ?? null;

  const loadingDetails = detailsFetcher.state !== "idle" && !details;

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

  const [modalOpenKind, setModalOpenKind] = React.useState<"transcript" | "raw" | null>(null);

  const itemsForDetails = React.useMemo(() => {
    const itemsJson = details?.checkout?.itemsJson ?? selected?.itemsJson ?? null;
    return toItemsArray(itemsJson);
  }, [details?.checkout?.itemsJson, selected?.itemsJson]);

  const modalHeading =
    modalOpenKind === "transcript" ? "Transcript" : modalOpenKind === "raw" ? "Raw payload" : "Details";

  const modalBody =
    modalOpenKind === "transcript" ? (
      <MonoPre value={sb?.transcript} />
    ) : modalOpenKind === "raw" ? (
      // keep it structured + readable
      // show supabase payload first, then checkout raw
      // (both are already available in the old UI)
      <>
        {/* @ts-ignore */}
        <s-stack gap="base">
          {/* @ts-ignore */}
          <s-section heading="End-of-call report">
            <MonoPre value={sb?.end_of_call_report} />
          </s-section>
          {/* @ts-ignore */}
          <s-section heading="AI result">
            <MonoPre value={sb?.ai_result} />
          </s-section>
          {/* @ts-ignore */}
          <s-section heading="Structured outputs">
            <MonoPre value={sb?.structured_outputs} />
          </s-section>
          {/* @ts-ignore */}
          <s-section heading="Payload">
            <MonoPre value={sb?.payload} />
          </s-section>
          {/* @ts-ignore */}
          <s-section heading="Checkout raw">
            <MonoPre value={details?.checkout?.raw} />
          </s-section>
        </s-stack>
      </>
    ) : (
      <MonoPre value={null} />
    );

  return (
    <>
      {/* @ts-ignore - custom element */}
      <s-page heading="Checkouts" inlineSize="large">
        {/* @ts-ignore */}
        <s-section>
          {/* @ts-ignore */}
          <s-stack gap="base">
            {/* TOP BAR: stats + search */}
            {/* @ts-ignore */}
            <s-grid columns="1fr 420px" gap="base" alignItems="start">
              {/* STATS */}
              {/* @ts-ignore */}
              <s-stack gap="small-100">
                {/* @ts-ignore */}
                <s-stack direction="inline" gap="small-100" wrap>
                  <Badge tone="info" label="Rows in current view">
                    {stats.total} rows
                  </Badge>
                  <Badge tone="critical" label="Abandoned count in current view">
                    Abandoned {stats.abandonedCount}
                  </Badge>
                  <Badge tone="warning" label="Open checkouts in current view">
                    Open {stats.openCount}
                  </Badge>
                  <Badge tone="success" label="Recovered/Converted in current view">
                    Recovered {stats.recoveredCount}
                  </Badge>
                  <Badge tone="warning" label="Sum of abandoned checkout value (current view)">
                    At-risk {stats.atRisk.toFixed(2)}
                  </Badge>
                  <Badge tone="success" label="Sum of recovered/converted value (current view)">
                    Recovered {stats.recovered.toFixed(2)}
                  </Badge>
                </s-stack>

                {/* @ts-ignore */}
                <s-text tone="subdued" variant="bodySm">
                  Click a checkout to view details on the right.
                </s-text>
              </s-stack>

              {/* SEARCH */}
              {/* @ts-ignore */}
              <s-text-field
                label="Search"
                value={query}
                placeholder="Search by customer, phone, email, status, cart, AI…"
                clearButton
                onInput={(e: any) => setQuery(String(e.currentTarget?.value ?? ""))}
                onClearButtonClick={() => setQuery("")}
              />
            </s-grid>

            {/* @ts-ignore */}
            <s-divider />

            {/* MAIN: list + details (side-by-side) */}
            {/* @ts-ignore */}
            <s-grid columns="minmax(420px, 1fr) minmax(420px, 1fr)" gap="base" alignItems="start">
              {/* LEFT: CLICKABLE LIST */}
              {/* @ts-ignore */}
              <s-section heading="Latest checkouts">
                {/* @ts-ignore */}
                <s-stack gap="small-100">
                  {filtered.length === 0 ? (
                    // @ts-ignore
                    <s-box padding="base" background="subdued" borderRadius="base">
                      {/* @ts-ignore */}
                      <s-text tone="subdued">No results.</s-text>
                    </s-box>
                  ) : (
                    filtered.map((c) => {
                      const isSel = c.checkoutId === selectedId;
                      const checkoutTone = toneForCheckoutStatus(c.status);
                      const callTone = c.callStatus ? toneForJobStatus(c.callStatus) : "neutral";
                      const outcomeTone = toneForOutcome(c.callOutcome);

                      const customer = safeStr(c.customerName) || "—";
                      const phone = safeStr(c.phone);
                      const updatedText = formatWhen(c.updatedAt);
                      const abandonedText = c.abandonedAt ? formatWhen(c.abandonedAt) : "";

                      return (
                        // @ts-ignore
                        <s-clickable
                          key={c.checkoutId}
                          accessibilityRole="button"
                          accessibilityLabel={`Open checkout ${c.checkoutId}`}
                          background={isSel ? "subdued" : "transparent"}
                          border="base"
                          borderRadius="base"
                          padding="base"
                          onClick={() => setSelectedId(c.checkoutId)}
                        >
                          {/* @ts-ignore */}
                          <s-grid columns="48px 1fr" gap="base" alignItems="start">
                            {/* THUMBNAIL */}
                            <div style={{ width: 48, height: 48 }}>
                              {/* @ts-ignore */}
                              <s-thumbnail
                                src={c.thumbUrl || undefined}
                                alt={c.thumbUrl ? "Cart item preview" : "No image available"}
                                size="small-200"
                              />
                            </div>

                            {/* CONTENT */}
                            {/* @ts-ignore */}
                            <s-stack gap="small-100">
                              {/* @ts-ignore */}
                              <s-stack direction="inline" gap="small-100" wrap alignItems="center">
                                {/* @ts-ignore */}
                                <s-text variant="bodyMd" fontWeight="semibold">
                                  {customer}
                                </s-text>
                                {phone ? (
                                  // @ts-ignore
                                  <s-text variant="bodySm" tone="subdued">
                                    {phone}
                                  </s-text>
                                ) : null}
                                {/* @ts-ignore */}
                                <s-text variant="bodySm" tone="subdued">
                                  #{c.checkoutId}
                                </s-text>
                              </s-stack>

                              {/* CART LINE */}
                              {safeStr(c.cartPreview) ? (
                                // @ts-ignore
                                <s-text variant="bodySm" tone="subdued">
                                  {safeStr(c.cartPreview)}
                                </s-text>
                              ) : (
                                // @ts-ignore
                                <s-text variant="bodySm" tone="subdued">
                                  —
                                </s-text>
                              )}

                              {/* BADGES */}
                              {/* @ts-ignore */}
                              <s-stack direction="inline" gap="small-100" wrap alignItems="center">
                                <Badge tone={checkoutTone}>{safeStr(c.status).toUpperCase()}</Badge>
                                {c.itemsCount ? <Badge tone="info">{c.itemsCount} items</Badge> : <Badge tone="neutral">0 items</Badge>}
                                {c.abandonedAt ? <Badge tone="info">Abandoned {abandonedText}</Badge> : null}
                                {c.callStatus ? <Badge tone={callTone}>{safeStr(c.callStatus).toUpperCase()}</Badge> : <Badge tone="neutral">NO CALL</Badge>}
                                <Badge tone={outcomeTone}>{c.callOutcome ? safeStr(c.callOutcome).toUpperCase() : "—"}</Badge>
                                {c.buyProbabilityPct == null ? <Badge tone="neutral">Buy —</Badge> : <Badge tone="info">Buy {c.buyProbabilityPct}%</Badge>}
                              </s-stack>

                              {/* FOOT */}
                              {/* @ts-ignore */}
                              <s-stack direction="inline" gap="small-100" wrap alignItems="center">
                                {/* @ts-ignore */}
                                <s-text variant="bodySm" tone="subdued">
                                  {Number(c.value || 0).toFixed(2)} {safeStr(c.currency)}
                                </s-text>
                                {/* @ts-ignore */}
                                <s-text variant="bodySm" tone="subdued">
                                  • Updated {updatedText}
                                </s-text>
                              </s-stack>
                            </s-stack>
                          </s-grid>
                        </s-clickable>
                      );
                    })
                  )}
                </s-stack>
              </s-section>

              {/* RIGHT: DETAILS */}
              {/* @ts-ignore */}
              <s-section heading="Details">
                {/* @ts-ignore */}
                <s-stack gap="base">
                  {/* header row */}
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
                    // details content
                    // @ts-ignore
                    <s-stack gap="base">
                      {/* status badges */}
                      {/* @ts-ignore */}
                      <s-stack direction="inline" gap="small-100" wrap>
                        <Badge tone={toneForCheckoutStatus(details?.checkout?.status ?? selected.status)}>
                          {safeStr(details?.checkout?.status ?? selected.status).toUpperCase()}
                        </Badge>

                        {details?.latestJob?.status ? (
                          <Badge tone={toneForJobStatus(details.latestJob.status)}>{safeStr(details.latestJob.status).toUpperCase()}</Badge>
                        ) : null}

                        {sb?.call_outcome ? <Badge tone={toneForOutcome(sb.call_outcome)}>{safeStr(sb.call_outcome).toUpperCase()}</Badge> : null}

                        {sb?.ai_status ? <Badge tone="info">{`AI ${safeStr(sb.ai_status).toUpperCase()}`}</Badge> : <Badge tone="neutral">AI —</Badge>}

                        {typeof sb?.buy_probability === "number" ? (
                          <Badge tone="info">{`Buy ${Math.round(sb.buy_probability)}%`}</Badge>
                        ) : (
                          <Badge tone="neutral">Buy —</Badge>
                        )}
                      </s-stack>

                      {/* key fields */}
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

                      {/* items list with thumbnails */}
                      {/* @ts-ignore */}
                      <s-section heading="Items">
                        {/* @ts-ignore */}
                        <s-stack gap="small-100">
                          {itemsForDetails.length === 0 ? (
                            // @ts-ignore
                            <s-text tone="subdued">—</s-text>
                          ) : (
                            itemsForDetails.slice(0, 25).map((it, idx) => {
                              const title = safeStr(it.title || it.name) || "Item";
                              const qtyRaw = it.quantity ?? it.qty ?? "";
                              const qty = safeStr(qtyRaw) ? `×${safeStr(qtyRaw)}` : "";
                              const img = pickThumbFromItem(it);
                              const subtitleParts = [safeStr(it.variantTitle), safeStr(it.sku)].filter(Boolean);
                              const subtitle = subtitleParts.join(" • ");

                              return (
                                // @ts-ignore
                                <s-box key={`${title}-${idx}`} border="base" borderRadius="base" padding="base">
                                  {/* @ts-ignore */}
                                  <s-grid columns="48px 1fr" gap="base" alignItems="center">
                                    <div style={{ width: 48, height: 48 }}>
                                      {/* @ts-ignore */}
                                      <s-thumbnail
                                        src={img || undefined}
                                        alt={img ? `Preview of ${title}` : "No image available"}
                                        size="small-200"
                                      />
                                    </div>
                                    {/* @ts-ignore */}
                                    <s-stack gap="small-100">
                                      {/* @ts-ignore */}
                                      <s-stack direction="inline" gap="small-100" wrap alignItems="center">
                                        {/* @ts-ignore */}
                                        <s-text variant="bodyMd" fontWeight="semibold">
                                          {title}
                                        </s-text>
                                        {qty ? <Badge tone="info">{qty}</Badge> : null}
                                      </s-stack>
                                      {subtitle ? (
                                        // @ts-ignore
                                        <s-text variant="bodySm" tone="subdued">
                                          {subtitle}
                                        </s-text>
                                      ) : null}
                                    </s-stack>
                                  </s-grid>
                                </s-box>
                              );
                            })
                          )}
                        </s-stack>
                      </s-section>

                      {/* actions */}
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
                          Open recording
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
                          Open logs
                        </s-button>

                        {/* transcript modal */}
                        {/* @ts-ignore */}
                        <s-button
                          variant="secondary"
                          commandFor="details-modal"
                          command="--show"
                          disabled={!safeStr(sb?.transcript).trim()}
                          onClick={() => setModalOpenKind("transcript")}
                        >
                          Transcript
                        </s-button>

                        {/* raw modal */}
                        {/* @ts-ignore */}
                        <s-button variant="secondary" commandFor="details-modal" command="--show" onClick={() => setModalOpenKind("raw")}>
                          Raw
                        </s-button>
                      </s-stack>

                      {/* summary sections */}
                      {/* @ts-ignore */}
                      <s-section heading="Summary">
                        {/* @ts-ignore */}
                        <s-text>{safeStr(sb?.summary_clean || sb?.summary) || "—"}</s-text>
                      </s-section>

                      {/* @ts-ignore */}
                      <s-section heading="Next best action">
                        {/* @ts-ignore */}
                        <s-text>{safeStr(sb?.next_best_action || sb?.best_next_action) || "—"}</s-text>
                      </s-section>

                      {/* @ts-ignore */}
                      <s-section heading="Follow-up message">
                        <MonoPre value={sb?.follow_up_message} />
                      </s-section>

                      {/* @ts-ignore */}
                      <s-section heading="Key quotes">
                        <MonoPre value={sb?.key_quotes_text || sb?.key_quotes} />
                      </s-section>

                      {/* @ts-ignore */}
                      <s-section heading="Objections">
                        <MonoPre value={sb?.objections_text || sb?.objections} />
                      </s-section>

                      {/* @ts-ignore */}
                      <s-section heading="Issues to fix">
                        <MonoPre value={sb?.issues_to_fix_text || sb?.issues_to_fix} />
                      </s-section>

                      {/* @ts-ignore */}
                      <s-section heading="Tags">
                        <MonoPre value={sb?.tagcsv || (Array.isArray(sb?.tags) ? sb.tags.join(", ") : "")} />
                      </s-section>

                      {/* misc badges */}
                      {/* @ts-ignore */}
                      <s-stack direction="inline" gap="small-100" wrap>
                        {sb?.latest_status ? <Badge tone="info">{`Latest ${safeStr(sb.latest_status)}`}</Badge> : null}
                        {sb?.ended_reason ? <Badge tone="info">{`Ended ${safeStr(sb.ended_reason)}`}</Badge> : null}
                        {sb?.answered != null ? <Badge tone="info">{`Answered ${String(sb.answered)}`}</Badge> : null}
                        {sb?.voicemail != null ? <Badge tone="info">{`Voicemail ${String(sb.voicemail)}`}</Badge> : null}
                        {sb?.sentiment ? <Badge tone="info">{`Sentiment ${safeStr(sb.sentiment)}`}</Badge> : null}
                        {sb?.customer_intent ? <Badge tone="info">{`Intent ${safeStr(sb.customer_intent)}`}</Badge> : null}
                        {sb?.tone ? <Badge tone="info">{`Tone ${safeStr(sb.tone)}`}</Badge> : null}
                      </s-stack>
                    </s-stack>
                  )}
                </s-stack>
              </s-section>
            </s-grid>
          </s-stack>
        </s-section>
      </s-page>

      {/* MODAL (App Home Polaris web components) */}
      {/* @ts-ignore */}
      <s-modal id="details-modal" heading={modalHeading} padding="base" onClose={() => setModalOpenKind(null)}>
        {modalBody}

        {/* @ts-ignore */}
        <s-button slot="secondary-actions" variant="secondary" commandFor="details-modal" command="--hide" onClick={() => setModalOpenKind(null)}>
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