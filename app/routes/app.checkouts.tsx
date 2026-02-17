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
function toneForCheckoutStatus(status: string): "success" | "critical" | "warning" | "info" {
  const s = safeStr(status).toUpperCase();
  if (s === "CONVERTED" || s === "RECOVERED") return "success";
  if (s === "ABANDONED") return "critical";
  if (s === "OPEN") return "warning";
  return "info";
}
function toneForJobStatus(status: string): "success" | "critical" | "warning" | "info" {
  const s = safeStr(status).toUpperCase();
  if (s === "COMPLETED") return "success";
  if (s === "CALLING") return "warning";
  if (s === "QUEUED") return "warning";
  if (s === "FAILED") return "critical";
  return "info";
}
function toneForOutcome(outcome: string | null): "success" | "critical" | "warning" | "info" {
  const s = safeStr(outcome).toLowerCase();
  if (!s) return "info";
  if (s.includes("recovered") || s.includes("converted")) return "success";
  if (s.includes("no_answer") || s.includes("voicemail")) return "warning";
  if (s.includes("needs_follow") || s.includes("needs follow") || s.includes("follow")) return "warning";
  if (s.includes("not_recovered") || s.includes("not interested")) return "critical";
  return "info";
}

function Badge({ tone, children, title }: { tone?: any; children: any; title?: string }) {
  return (
    <s-badge tone={tone as any} title={title}>
      {children}
    </s-badge>
  );
}

/* ---------------- Types ---------------- */
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
  cartPreview: string | null;

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

  // IMPORTANT: pick the *latest* summary per key (Supabase can have multiple rows per checkout/call/job).
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

    // include received timestamps so we can deterministically pick the newest
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
    // bias results toward newest
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

    // try shop-filtered first, then fallback (in case shop column missing on some rows)
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
      cartPreview: buildCartPreview(c.itemsJson ?? null),

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

/* ---------------- UI helpers ---------------- */
function PreBlock({ value }: { value: any }) {
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
    <div
      style={{
        padding: 10,
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.10)",
        background: "rgba(0,0,0,0.02)",
      }}
    >
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, fontWeight: 750 }}>
        {text || "—"}
      </pre>
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 950, fontSize: 12, color: "rgba(17,24,39,0.55)" }}>{label}</div>
      <div style={{ fontWeight: 950, color: "rgba(17,24,39,0.90)" }}>{children}</div>
    </div>
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
    // if current selection disappears due to filtering, select first row
    if (selectedId && !filtered.some((r) => r.checkoutId === selectedId)) {
      setSelectedId(filtered?.[0]?.checkoutId ?? null);
    }
  }, [selectedId, filtered]);

  const selected = React.useMemo(() => filtered.find((r) => r.checkoutId === selectedId) ?? null, [filtered, selectedId]);

  const detailsFetcher = useFetcher<any>();

  React.useEffect(() => {
    if (!selected?.checkoutId) return;
    detailsFetcher.load(withSearch(`/app/checkouts/${encodeURIComponent(selected.checkoutId)}`));
  }, [selected?.checkoutId]);

  const details = detailsFetcher.data?.shop ? detailsFetcher.data : null;
  const sb = details?.sb ?? null;

  const headerCell: React.CSSProperties = {
    position: "sticky",
    top: 0,
    background: "white",
    zIndex: 1,
    borderBottom: "1px solid rgba(0,0,0,0.08)",
    padding: "10px 10px",
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(17,24,39,0.55)",
    whiteSpace: "nowrap",
  };

  const cell: React.CSSProperties = {
    padding: "10px 10px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    verticalAlign: "top",
    fontSize: 13,
    fontWeight: 850,
    color: "rgba(17,24,39,0.78)",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  return (
    <s-page heading="Checkouts">
      <s-section>
        <s-card padding="base">
          {/* make the content wide to kill cramped layout */}
          <div style={{ width: "100%", maxWidth: 1680, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <s-paragraph>
                Store: <s-badge>{shop}</s-badge>
              </s-paragraph>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: "1px solid rgba(0,0,0,0.10)",
                  background: "rgba(0,0,0,0.02)",
                  borderRadius: 12,
                  padding: "8px 10px",
                  minWidth: 360,
                  flex: "0 1 520px",
                }}
              >
                <span style={{ fontWeight: 1000, color: "rgba(17,24,39,0.45)" }}>⌕</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search checkouts..."
                  style={{
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    width: "100%",
                    fontWeight: 900,
                    color: "rgba(17,24,39,0.85)",
                  }}
                />
                <Badge tone="info" title="Rows">
                  {filtered.length}
                </Badge>
              </div>
            </div>

            <div
              style={{
                marginTop: 12,
                display: "grid",
                gridTemplateColumns: "minmax(0, 1.55fr) minmax(560px, 1fr)",
                gap: 12,
                alignItems: "start",
                minWidth: 0,
              }}
            >
              {/* TABLE (no internal scrollbars, no forced minWidth) */}
              <div
                style={{
                  border: "1px solid rgba(0,0,0,0.08)",
                  borderRadius: 16,
                  overflow: "hidden",
                  background: "white",
                  minWidth: 0,
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th style={{ ...headerCell, width: 150 }}>Customer</th>
                      <th style={{ ...headerCell, width: 140 }}>Phone</th>
                      <th style={{ ...headerCell, width: 110 }}>Value</th>
                      <th style={{ ...headerCell, width: 340 }}>Cart</th>
                      <th style={{ ...headerCell, width: 120 }}>Checkout</th>
                      <th style={{ ...headerCell, width: 110 }}>Call</th>
                      <th style={{ ...headerCell, width: 140 }}>Outcome</th>
                      <th style={{ ...headerCell, width: 90 }}>Buy</th>
                      <th style={{ ...headerCell, width: 110 }}>Recording</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => {
                      const isSel = c.checkoutId === selectedId;
                      return (
                        <tr
                          key={c.checkoutId}
                          onClick={() => setSelectedId(c.checkoutId)}
                          style={{
                            cursor: "pointer",
                            background: isSel ? "rgba(0,0,0,0.03)" : "white",
                          }}
                          title={`Checkout ${c.checkoutId}`}
                        >
                          <td style={cell}>{c.customerName ?? "-"}</td>
                          <td style={cell}>{c.phone ?? "-"}</td>
                          <td style={cell}>
                            {c.value} {c.currency}
                          </td>
                          <td style={{ ...cell, whiteSpace: "normal" }}>
                            <div style={{ fontWeight: 900, color: "rgba(17,24,39,0.90)" }}>{c.cartPreview ?? "-"}</div>
                            <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <Badge tone={toneForCheckoutStatus(c.status)}>{safeStr(c.status).toUpperCase()}</Badge>
                              {c.abandonedAt ? <Badge tone="info">{`Abandoned: ${formatWhen(c.abandonedAt)}`}</Badge> : null}
                              <Badge tone="info">{`Updated: ${formatWhen(c.updatedAt)}`}</Badge>
                              <Badge tone="info">{`ID: ${c.checkoutId}`}</Badge>
                            </div>
                          </td>
                          <td style={cell}>
                            <Badge tone={toneForCheckoutStatus(c.status)}>{safeStr(c.status).toUpperCase()}</Badge>
                          </td>
                          <td style={cell}>
                            {c.callStatus ? (
                              <Badge tone={toneForJobStatus(c.callStatus)}>{safeStr(c.callStatus).toUpperCase()}</Badge>
                            ) : (
                              <Badge tone="info">—</Badge>
                            )}
                          </td>
                          <td style={cell}>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <Badge tone={toneForOutcome(c.callOutcome)}>
                                {c.callOutcome ? safeStr(c.callOutcome).toUpperCase() : "—"}
                              </Badge>
                              {c.aiStatus ? <Badge tone="info">{`AI: ${safeStr(c.aiStatus).toUpperCase()}`}</Badge> : <Badge tone="info">AI: —</Badge>}
                            </div>
                          </td>
                          <td style={cell}>
                            {c.buyProbabilityPct == null ? <Badge tone="info">—</Badge> : <Badge tone="info">{c.buyProbabilityPct}%</Badge>}
                          </td>
                          <td style={cell}>
                            <button
                              type="button"
                              disabled={!c.recordingUrl}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (c.recordingUrl) window.open(c.recordingUrl, "_blank", "noreferrer");
                              }}
                              style={{
                                padding: "8px 10px",
                                borderRadius: 12,
                                border: "1px solid rgba(0,0,0,0.12)",
                                background: c.recordingUrl ? "white" : "rgba(0,0,0,0.03)",
                                cursor: c.recordingUrl ? "pointer" : "not-allowed",
                                fontWeight: 950,
                                opacity: c.recordingUrl ? 1 : 0.55,
                                width: "100%",
                              }}
                            >
                              Open
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* DETAILS (no tabs, everything stacked) */}
              <div style={{ position: "sticky", top: 12, minWidth: 0 }}>
                <div style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, background: "white", padding: 12 }}>
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={{ fontWeight: 1100, fontSize: 14 }}>Details</div>
                    <div style={{ fontWeight: 850, fontSize: 12, color: "rgba(17,24,39,0.55)" }}>
                      {selected ? `Checkout ${selected.checkoutId}` : "Select a checkout"}
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    {!selected ? (
                      <div style={{ fontWeight: 850, color: "rgba(17,24,39,0.55)" }}>—</div>
                    ) : detailsFetcher.state !== "idle" && !details ? (
                      <div style={{ fontWeight: 850, color: "rgba(17,24,39,0.55)" }}>Loading…</div>
                    ) : (
                      <div style={{ display: "grid", gap: 12 }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <Badge tone={toneForCheckoutStatus(details?.checkout?.status ?? selected.status)}>
                            {safeStr(details?.checkout?.status ?? selected.status).toUpperCase()}
                          </Badge>
                          {details?.latestJob?.status ? (
                            <Badge tone={toneForJobStatus(details.latestJob.status)}>{safeStr(details.latestJob.status).toUpperCase()}</Badge>
                          ) : null}
                          {sb?.call_outcome ? <Badge tone={toneForOutcome(sb.call_outcome)}>{safeStr(sb.call_outcome).toUpperCase()}</Badge> : null}
                          {sb?.ai_status ? <Badge tone="info">{`AI: ${safeStr(sb.ai_status).toUpperCase()}`}</Badge> : null}
                          {typeof sb?.buy_probability === "number" ? <Badge tone="info">{`Buy: ${Math.round(sb.buy_probability)}%`}</Badge> : null}
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <Field label="Customer">{details?.checkout?.customerName ?? selected.customerName ?? "-"}</Field>
                          <Field label="Phone">{details?.checkout?.phone ?? selected.phone ?? "-"}</Field>
                          <Field label="Email">{details?.checkout?.email ?? selected.email ?? "-"}</Field>
                          <Field label="Cart total">
                            {safeStr(details?.checkout?.value ?? selected.value)} {safeStr(details?.checkout?.currency ?? selected.currency)}
                          </Field>
                        </div>

                        <Field label="Cart">{selected.cartPreview ?? "-"}</Field>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            disabled={!(details?.recordingUrl ?? selected.recordingUrl)}
                            onClick={() => {
                              const url = details?.recordingUrl ?? selected.recordingUrl;
                              if (url) window.open(url, "_blank", "noreferrer");
                            }}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 12,
                              border: "1px solid rgba(0,0,0,0.12)",
                              background: "white",
                              cursor: "pointer",
                              fontWeight: 950,
                              opacity: details?.recordingUrl ?? selected.recordingUrl ? 1 : 0.55,
                            }}
                          >
                            Open recording
                          </button>

                          <button
                            type="button"
                            disabled={!safeStr(sb?.log_url).trim()}
                            onClick={() => {
                              const url = safeStr(sb?.log_url).trim();
                              if (url) window.open(url, "_blank", "noreferrer");
                            }}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 12,
                              border: "1px solid rgba(0,0,0,0.12)",
                              background: "white",
                              cursor: "pointer",
                              fontWeight: 950,
                              opacity: safeStr(sb?.log_url).trim() ? 1 : 0.55,
                            }}
                          >
                            Open logs
                          </button>
                        </div>

                        <s-divider />

                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ fontWeight: 1100 }}>Summary</div>
                          <div style={{ fontWeight: 850, color: "rgba(17,24,39,0.80)" }}>{safeStr(sb?.summary_clean || sb?.summary) || "—"}</div>

                          <div style={{ fontWeight: 1100 }}>Next best action</div>
                          <div style={{ fontWeight: 850, color: "rgba(17,24,39,0.80)" }}>
                            {safeStr(sb?.next_best_action || sb?.best_next_action) || "—"}
                          </div>

                          <div style={{ fontWeight: 1100 }}>Follow-up message</div>
                          <PreBlock value={sb?.follow_up_message} />

                          <div style={{ fontWeight: 1100 }}>Key quotes</div>
                          <PreBlock value={sb?.key_quotes_text || sb?.key_quotes} />

                          <div style={{ fontWeight: 1100 }}>Objections</div>
                          <PreBlock value={sb?.objections_text || sb?.objections} />

                          <div style={{ fontWeight: 1100 }}>Issues to fix</div>
                          <PreBlock value={sb?.issues_to_fix_text || sb?.issues_to_fix} />

                          <div style={{ fontWeight: 1100 }}>Tags</div>
                          <PreBlock value={sb?.tagcsv || (Array.isArray(sb?.tags) ? sb.tags.join(", ") : "")} />

                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {sb?.latest_status ? <Badge tone="info">{`Latest: ${safeStr(sb.latest_status)}`}</Badge> : null}
                            {sb?.ended_reason ? <Badge tone="info">{`Ended: ${safeStr(sb.ended_reason)}`}</Badge> : null}
                            {sb?.answered != null ? <Badge tone="info">{`Answered: ${String(sb.answered)}`}</Badge> : null}
                            {sb?.voicemail != null ? <Badge tone="info">{`Voicemail: ${String(sb.voicemail)}`}</Badge> : null}
                            {sb?.sentiment ? <Badge tone="info">{`Sentiment: ${safeStr(sb.sentiment)}`}</Badge> : null}
                            {sb?.customer_intent ? <Badge tone="info">{`Intent: ${safeStr(sb.customer_intent)}`}</Badge> : null}
                            {sb?.tone ? <Badge tone="info">{`Tone: ${safeStr(sb.tone)}`}</Badge> : null}
                          </div>

                          <div style={{ fontWeight: 1100 }}>Transcript</div>
                          <PreBlock value={sb?.transcript} />

                          <details>
                            <summary style={{ cursor: "pointer", fontWeight: 1100 }}>Raw payload</summary>
                            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                              <div style={{ fontWeight: 1000 }}>End-of-call report</div>
                              <PreBlock value={sb?.end_of_call_report} />

                              <div style={{ fontWeight: 1000 }}>AI result</div>
                              <PreBlock value={sb?.ai_result} />

                              <div style={{ fontWeight: 1000 }}>Structured outputs</div>
                              <PreBlock value={sb?.structured_outputs} />

                              <div style={{ fontWeight: 1000 }}>Payload</div>
                              <PreBlock value={sb?.payload} />

                              <div style={{ fontWeight: 1000 }}>Checkout raw</div>
                              <PreBlock value={details?.checkout?.raw} />
                            </div>
                          </details>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </s-card>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
