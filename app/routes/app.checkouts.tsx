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

import {
  Page,
  Layout,
  Card,
  TextField,
  Badge,
  Button,
  InlineStack,
  BlockStack,
  Box,
  Text,
  IndexTable,
  Tooltip,
  Divider,
  Collapsible,
  Spinner,
} from "@shopify/polaris";

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
type PolarisTone = "success" | "critical" | "warning" | "info" | "new";

function toneForCheckoutStatus(status: string): PolarisTone {
  const s = safeStr(status).toUpperCase();
  if (s === "CONVERTED" || s === "RECOVERED") return "success";
  if (s === "ABANDONED") return "critical";
  if (s === "OPEN") return "warning";
  return "info";
}
function toneForJobStatus(status: string): PolarisTone {
  const s = safeStr(status).toUpperCase();
  if (s === "COMPLETED") return "success";
  if (s === "CALLING") return "warning";
  if (s === "QUEUED") return "warning";
  if (s === "FAILED") return "critical";
  return "info";
}
function toneForOutcome(outcome: string | null): PolarisTone {
  const s = safeStr(outcome).toLowerCase();
  if (!s) return "info";
  if (s.includes("recovered") || s.includes("converted")) return "success";
  if (s.includes("no_answer") || s.includes("voicemail")) return "warning";
  if (s.includes("needs_follow") || s.includes("needs follow") || s.includes("follow")) return "warning";
  if (s.includes("not_recovered") || s.includes("not interested")) return "critical";
  return "info";
}

function PBadge({
  tone,
  children,
  tooltip,
}: {
  tone: PolarisTone;
  children: React.ReactNode;
  tooltip?: string;
}) {
  const b = (
    <Badge tone={tone as any} size="small">
      {children}
    </Badge>
  );
  return tooltip ? <Tooltip content={tooltip}>{b}</Tooltip> : b;
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
    <Box
      padding="300"
      background="bg-surface-secondary"
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
    >
      <div
        style={{
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 12,
          fontWeight: 650,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
        }}
      >
        {text || "—"}
      </div>
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <BlockStack gap="100">
      <Text variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text variant="bodyMd" fontWeight="semibold">
        {children}
      </Text>
    </BlockStack>
  );
}

function sumMoney(rows: Row[], pred: (r: Row) => boolean) {
  let n = 0;
  for (const r of rows) if (pred(r)) n += Number(r.value || 0);
  return n;
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

  const selected = React.useMemo(() => filtered.find((r) => r.checkoutId === selectedId) ?? null, [filtered, selectedId]);

  const detailsFetcher = useFetcher<any>();
  React.useEffect(() => {
    if (!selected?.checkoutId) return;
    detailsFetcher.load(withSearch(`/app/checkouts/${encodeURIComponent(selected.checkoutId)}`));
  }, [selected?.checkoutId]);

  const details = detailsFetcher.data?.shop ? detailsFetcher.data : null;
  const sb = details?.sb ?? null;

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

  const headings = [
    { title: "Customer / Cart" },
    { title: "Value" },
    { title: "Checkout" },
    { title: "Call" },
    { title: "Outcome" },
    { title: "Buy" },
    { title: "Updated" },
    { title: "Rec" },
  ];

  const loadingDetails = detailsFetcher.state !== "idle" && !details;

  return (
    <Page title="Checkouts" subtitle={shop}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" wrap gap="300">
                <InlineStack gap="200" wrap>
                  <PBadge tone="info" tooltip="Rows in current view">
                    {stats.total} rows
                  </PBadge>
                  <PBadge tone="critical" tooltip="Abandoned count in current view">
                    Abandoned {stats.abandonedCount}
                  </PBadge>
                  <PBadge tone="warning" tooltip="Open checkouts in current view">
                    Open {stats.openCount}
                  </PBadge>
                  <PBadge tone="success" tooltip="Recovered/Converted in current view">
                    Recovered {stats.recoveredCount}
                  </PBadge>
                  <PBadge tone="warning" tooltip="Sum of abandoned checkout value (current view)">
                    At-risk {stats.atRisk.toFixed(2)}
                  </PBadge>
                  <PBadge tone="success" tooltip="Sum of recovered/converted value (current view)">
                    Recovered {stats.recovered.toFixed(2)}
                  </PBadge>
                </InlineStack>

                <Box minWidth="320px" width="100%" maxWidth="520px">
                  <TextField
                    label="Search"
                    labelHidden
                    value={query}
                    onChange={setQuery}
                    placeholder="Search by customer, phone, email, status, cart, AI…"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setQuery("")}
                  />
                </Box>
              </InlineStack>

              <Divider />

              <IndexTable
                resourceName={{ singular: "checkout", plural: "checkouts" }}
                itemCount={filtered.length}
                headings={headings as any}
                selectable={false}
              >
                {filtered.map((c, index) => {
                  const isSel = c.checkoutId === selectedId;
                  const checkoutTone = toneForCheckoutStatus(c.status);
                  const callTone = c.callStatus ? toneForJobStatus(c.callStatus) : "info";
                  const outcomeTone = toneForOutcome(c.callOutcome);

                  const cartLine = safeStr(c.cartPreview);
                  const customer = safeStr(c.customerName) || "—";
                  const phone = safeStr(c.phone);

                  const updatedText = formatWhen(c.updatedAt);
                  const abandonedText = c.abandonedAt ? formatWhen(c.abandonedAt) : "";

                  return (
                    <IndexTable.Row
                      id={c.checkoutId}
                      key={c.checkoutId}
                      position={index}
                      selected={isSel}
                      onClick={() => setSelectedId(c.checkoutId)}
                    >
                      <IndexTable.Cell>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center" wrap>
                            <Text variant="bodyMd" fontWeight="semibold">
                              {customer}
                            </Text>
                            {phone ? (
                              <Text variant="bodySm" tone="subdued">
                                {phone}
                              </Text>
                            ) : null}
                            <Text variant="bodySm" tone="subdued">
                              #{c.checkoutId}
                            </Text>
                          </InlineStack>

                          {cartLine ? (
                            <Tooltip content={cartLine}>
                              <Text variant="bodySm" tone="subdued" truncate>
                                {cartLine}
                              </Text>
                            </Tooltip>
                          ) : (
                            <Text variant="bodySm" tone="subdued">
                              —
                            </Text>
                          )}

                          <InlineStack gap="200" wrap>
                            <PBadge tone={checkoutTone}>{safeStr(c.status).toUpperCase()}</PBadge>
                            {c.abandonedAt ? (
                              <PBadge tone="info" tooltip={`Abandoned at ${c.abandonedAt}`}>
                                Abandoned {abandonedText}
                              </PBadge>
                            ) : null}
                          </InlineStack>
                        </BlockStack>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Text variant="bodyMd" fontWeight="semibold">
                          {Number(c.value || 0).toFixed(2)} {safeStr(c.currency)}
                        </Text>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <PBadge tone={checkoutTone}>{safeStr(c.status).toUpperCase()}</PBadge>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        {c.callStatus ? <PBadge tone={callTone}>{safeStr(c.callStatus).toUpperCase()}</PBadge> : <PBadge tone="info">—</PBadge>}
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <InlineStack gap="200" wrap>
                          <PBadge tone={outcomeTone}>{c.callOutcome ? safeStr(c.callOutcome).toUpperCase() : "—"}</PBadge>
                          <PBadge tone="info">{`AI: ${c.aiStatus ? safeStr(c.aiStatus).toUpperCase() : "—"}`}</PBadge>
                        </InlineStack>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        {c.buyProbabilityPct == null ? <PBadge tone="info">—</PBadge> : <PBadge tone="info">{c.buyProbabilityPct}%</PBadge>}
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Text variant="bodySm" tone="subdued">
                          {updatedText}
                        </Text>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Button
                          variant="tertiary"
                          disabled={!c.recordingUrl}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (c.recordingUrl) window.open(c.recordingUrl, "_blank", "noreferrer");
                          }}
                        >
                          Open
                        </Button>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section secondary>
          <div style={{ position: "sticky", top: 16 }}>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">
                      Details
                    </Text>
                    <Text variant="bodySm" tone="subdued">
                      {selected ? `Checkout #${selected.checkoutId}` : "Select a checkout"}
                    </Text>
                  </BlockStack>
                  {loadingDetails ? <Spinner size="small" /> : null}
                </InlineStack>

                <Divider />

                {!selected ? (
                  <Text tone="subdued">—</Text>
                ) : loadingDetails ? (
                  <Text tone="subdued">Loading…</Text>
                ) : (
                  <BlockStack gap="300">
                    <InlineStack gap="200" wrap>
                      <PBadge tone={toneForCheckoutStatus(details?.checkout?.status ?? selected.status)}>
                        {safeStr(details?.checkout?.status ?? selected.status).toUpperCase()}
                      </PBadge>
                      {details?.latestJob?.status ? (
                        <PBadge tone={toneForJobStatus(details.latestJob.status)}>
                          {safeStr(details.latestJob.status).toUpperCase()}
                        </PBadge>
                      ) : null}
                      {sb?.call_outcome ? (
                        <PBadge tone={toneForOutcome(sb.call_outcome)}>{safeStr(sb.call_outcome).toUpperCase()}</PBadge>
                      ) : null}
                      {sb?.ai_status ? <PBadge tone="info">{`AI: ${safeStr(sb.ai_status).toUpperCase()}`}</PBadge> : null}
                      {typeof sb?.buy_probability === "number" ? (
                        <PBadge tone="info">{`Buy: ${Math.round(sb.buy_probability)}%`}</PBadge>
                      ) : null}
                    </InlineStack>

                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="300">
                        <InlineStack gap="600" wrap>
                          <Field label="Customer">{details?.checkout?.customerName ?? selected.customerName ?? "—"}</Field>
                          <Field label="Phone">{details?.checkout?.phone ?? selected.phone ?? "—"}</Field>
                          <Field label="Email">{details?.checkout?.email ?? selected.email ?? "—"}</Field>
                        </InlineStack>

                        <InlineStack gap="600" wrap>
                          <Field label="Cart total">
                            {safeStr(details?.checkout?.value ?? selected.value)} {safeStr(details?.checkout?.currency ?? selected.currency)}
                          </Field>
                          <Field label="Updated">{formatWhen(details?.checkout?.updatedAt ?? selected.updatedAt)}</Field>
                          <Field label="Abandoned">{details?.checkout?.abandonedAt ? formatWhen(details.checkout.abandonedAt) : "—"}</Field>
                        </InlineStack>

                        <Field label="Cart">{selected.cartPreview ?? "—"}</Field>
                      </BlockStack>
                    </Box>

                    <InlineStack gap="200" wrap>
                      <Button
                        variant="primary"
                        disabled={!(details?.recordingUrl ?? selected.recordingUrl)}
                        onClick={() => {
                          const url = details?.recordingUrl ?? selected.recordingUrl;
                          if (url) window.open(url, "_blank", "noreferrer");
                        }}
                      >
                        Open recording
                      </Button>

                      <Button
                        variant="secondary"
                        disabled={!safeStr(sb?.log_url).trim()}
                        onClick={() => {
                          const url = safeStr(sb?.log_url).trim();
                          if (url) window.open(url, "_blank", "noreferrer");
                        }}
                      >
                        Open logs
                      </Button>
                    </InlineStack>

                    <Divider />

                    <BlockStack gap="300">
                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Summary
                        </Text>
                        <Text>{safeStr(sb?.summary_clean || sb?.summary) || "—"}</Text>
                      </BlockStack>

                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Next best action
                        </Text>
                        <Text>{safeStr(sb?.next_best_action || sb?.best_next_action) || "—"}</Text>
                      </BlockStack>

                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Follow-up message
                        </Text>
                        <PreBlock value={sb?.follow_up_message} />
                      </BlockStack>

                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Key quotes
                        </Text>
                        <PreBlock value={sb?.key_quotes_text || sb?.key_quotes} />
                      </BlockStack>

                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Objections
                        </Text>
                        <PreBlock value={sb?.objections_text || sb?.objections} />
                      </BlockStack>

                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Issues to fix
                        </Text>
                        <PreBlock value={sb?.issues_to_fix_text || sb?.issues_to_fix} />
                      </BlockStack>

                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Tags
                        </Text>
                        <PreBlock value={sb?.tagcsv || (Array.isArray(sb?.tags) ? sb.tags.join(", ") : "")} />
                      </BlockStack>

                      <InlineStack gap="200" wrap>
                        {sb?.latest_status ? <PBadge tone="info">{`Latest: ${safeStr(sb.latest_status)}`}</PBadge> : null}
                        {sb?.ended_reason ? <PBadge tone="info">{`Ended: ${safeStr(sb.ended_reason)}`}</PBadge> : null}
                        {sb?.answered != null ? <PBadge tone="info">{`Answered: ${String(sb.answered)}`}</PBadge> : null}
                        {sb?.voicemail != null ? <PBadge tone="info">{`Voicemail: ${String(sb.voicemail)}`}</PBadge> : null}
                        {sb?.sentiment ? <PBadge tone="info">{`Sentiment: ${safeStr(sb.sentiment)}`}</PBadge> : null}
                        {sb?.customer_intent ? <PBadge tone="info">{`Intent: ${safeStr(sb.customer_intent)}`}</PBadge> : null}
                        {sb?.tone ? <PBadge tone="info">{`Tone: ${safeStr(sb.tone)}`}</PBadge> : null}
                      </InlineStack>

                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          Transcript
                        </Text>
                        <PreBlock value={sb?.transcript} />
                      </BlockStack>

                      <RawSection sb={sb} checkoutRaw={details?.checkout?.raw} />
                    </BlockStack>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function RawSection({ sb, checkoutRaw }: { sb: any; checkoutRaw: any }) {
  const [open, setOpen] = React.useState(false);

  return (
    <BlockStack gap="200">
      <Button variant="tertiary" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide raw payload" : "Show raw payload"}
      </Button>

      <Collapsible open={open} id="raw-payload">
        <Box paddingBlockStart="200">
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text variant="headingSm" as="h3">
                End-of-call report
              </Text>
              <PreBlock value={sb?.end_of_call_report} />
            </BlockStack>

            <BlockStack gap="100">
              <Text variant="headingSm" as="h3">
                AI result
              </Text>
              <PreBlock value={sb?.ai_result} />
            </BlockStack>

            <BlockStack gap="100">
              <Text variant="headingSm" as="h3">
                Structured outputs
              </Text>
              <PreBlock value={sb?.structured_outputs} />
            </BlockStack>

            <BlockStack gap="100">
              <Text variant="headingSm" as="h3">
                Payload
              </Text>
              <PreBlock value={sb?.payload} />
            </BlockStack>

            <BlockStack gap="100">
              <Text variant="headingSm" as="h3">
                Checkout raw
              </Text>
              <PreBlock value={checkoutRaw} />
            </BlockStack>
          </BlockStack>
        </Box>
      </Collapsible>
    </BlockStack>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
