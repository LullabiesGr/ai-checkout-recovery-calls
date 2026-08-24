// app/routes/app.calls.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  ensureSettings,
  markAbandonedByDelay,
  syncAbandonedCheckoutsFromShopify,
} from "../callRecovery.server";
import { createVapiCallForJob } from "../callProvider.server";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

function safeStr(v: any) {
  return v == null ? "" : String(v);
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

type CallRow = {
  id: string;
  checkoutId: string;
  status: string;
  scheduledFor: string;
  createdAt: string;
  attempts: number;
  providerCallId: string | null;
  callOutcome: string | null;
  aiStatus: string | null;
  summary: string | null;
  nextAction: string | null;
  followUp: string | null;
  recordingUrl: string | null;
  openaiOutcome: string | null;
  sentSystemPrompt: string | null;
};

function normalizeOutcome(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    return s.toLowerCase();
  }
  if (typeof v === "object") {
    const s = String((v as any)?.outcome ?? (v as any)?.call_outcome ?? "").trim();
    return s ? s.toLowerCase() : null;
  }
  return String(v).trim().toLowerCase() || null;
}

function pickOpenAIOutcome(sb: any): string | null {
  const a = normalizeOutcome(sb?.ai_result);
  if (a && a !== "{}") return a;
  const c = normalizeOutcome(sb?.call_outcome);
  return c;
}

function pickSentSystemPrompt(sb: any): string | null {
  const payload = sb?.payload;
  if (!payload) return null;

  const msgs =
    payload?.message?.artifact?.messagesOpenAIFormatted ||
    payload?.artifact?.messagesOpenAIFormatted ||
    payload?.messagesOpenAIFormatted ||
    null;

  if (!Array.isArray(msgs)) return null;

  const sys = msgs.find((m: any) => String(m?.role ?? "") === "system");
  const content = safeStr(sys?.content ?? sys?.message ?? "").trim();
  return content || null;
}

type LoaderData = {
  shop: string;
  providerConfigured: boolean;
  stats: { queued: number; calling: number; completed7d: number };
  rows: CallRow[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
  await markAbandonedByDelay(shop, settings.delayMinutes);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [queued, calling, completed7d, jobs] = await Promise.all([
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        createdAt: true,
        attempts: true,
        providerCallId: true,
        recordingUrl: true,
      },
    }),
  ]);

  const providerConfigured =
    Boolean(process.env.VAPI_API_KEY?.trim()) &&
    Boolean(process.env.VAPI_PHONE_NUMBER_ID?.trim()) &&
    Boolean(process.env.VAPI_SERVER_URL?.trim());

  const callIds = jobs.map((j) => String(j.providerCallId ?? "")).filter(Boolean);
  const jobIds = jobs.map((j) => String(j.id ?? "")).filter(Boolean);
  const checkoutIds = jobs.map((j) => String(j.checkoutId ?? "")).filter(Boolean);

  const { fetchSupabaseSummaries, pickRecordingUrl } = await import("../lib/callInsights.server");
  const sbMap = await fetchSupabaseSummaries({ shop, callIds, callJobIds: jobIds, checkoutIds });

  const rows: CallRow[] = jobs.map((j) => {
    const callId = j.providerCallId ? String(j.providerCallId) : "";
    const jobId = String(j.id);
    const coId = String(j.checkoutId);

    const sb =
      (callId ? sbMap.get(`call:${callId}`) : null) ||
      (jobId ? sbMap.get(`job:${jobId}`) : null) ||
      (coId ? sbMap.get(`co:${coId}`) : null) ||
      null;

    const openaiOutcome = pickOpenAIOutcome(sb as any);
    const sentSystemPrompt = pickSentSystemPrompt(sb as any);

    return {
      id: String(j.id),
      checkoutId: String(j.checkoutId),
      status: String(j.status),
      scheduledFor: new Date(j.scheduledFor).toISOString(),
      createdAt: new Date(j.createdAt).toISOString(),
      attempts: Number(j.attempts ?? 0),
      providerCallId: j.providerCallId ? String(j.providerCallId) : null,
      callOutcome: sb?.call_outcome ? String(sb.call_outcome) : null,
      aiStatus: sb?.ai_status ? String(sb.ai_status) : null,
      summary: safeStr((sb as any)?.summary_clean || (sb as any)?.summary).trim() || null,
      nextAction: safeStr((sb as any)?.next_best_action || (sb as any)?.best_next_action).trim() || null,
      followUp: safeStr((sb as any)?.follow_up_message).trim() || null,
      recordingUrl: (pickRecordingUrl(sb as any) ?? (j.recordingUrl ? String(j.recordingUrl) : null)) ?? null,
      openaiOutcome,
      sentSystemPrompt,
    };
  });

  return { shop, providerConfigured, stats: { queued, calling, completed7d }, rows } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  const redirectBack = () => new Response(null, { status: 303, headers: { Location: "/app/calls" } });

  const providerOk =
    Boolean(process.env.VAPI_API_KEY?.trim()) &&
    Boolean(process.env.VAPI_PHONE_NUMBER_ID?.trim()) &&
    Boolean(process.env.VAPI_SERVER_URL?.trim());

  if (intent === "run_jobs") {
    const settings = await ensureSettings(shop);

    const now = new Date();
    const jobs = await db.callJob.findMany({
      where: { shop, status: "QUEUED", scheduledFor: { lte: now } },
      orderBy: { scheduledFor: "asc" },
      take: 10,
    });

    for (const job of jobs) {
      const locked = await db.callJob.updateMany({
        where: { id: job.id, shop, status: "QUEUED" },
        data: {
          status: "CALLING",
          attempts: { increment: 1 },
          provider: providerOk ? "vapi" : "sim",
          outcome: null,
        },
      });
      if (locked.count === 0) continue;

      if (!providerOk) {
        await db.callJob.update({
          where: { id: job.id },
          data: { status: "COMPLETED", outcome: `SIMULATED_CALL_OK phone=${(job as any).phone}` },
        });
        continue;
      }

      try {
        await createVapiCallForJob({ shop, callJobId: job.id });
        await db.callJob.update({ where: { id: job.id }, data: { status: "CALLING", outcome: "CALL_STARTED" } });
      } catch (e: any) {
        const maxAttempts = settings.maxAttempts ?? 2;
        const fresh = await db.callJob.findUnique({ where: { id: job.id }, select: { attempts: true } });
        const attemptsAfter = Number(fresh?.attempts ?? 0);

        if (attemptsAfter >= maxAttempts) {
          await db.callJob.update({
            where: { id: job.id },
            data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}` },
          });
        } else {
          const retryMinutes = settings.retryMinutes ?? 180;
          const next = new Date(Date.now() + retryMinutes * 60 * 1000);
          await db.callJob.update({
            where: { id: job.id },
            data: {
              status: "QUEUED",
              scheduledFor: next,
              outcome: `RETRY_SCHEDULED in ${retryMinutes}m`,
            },
          });
        }
      }
    }

    return redirectBack();
  }

  if (intent === "manual_call") {
    const callJobId = String(fd.get("callJobId") ?? "").trim();
    if (!callJobId) return redirectBack();

    if (!providerOk) {
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: { outcome: "Missing call provider configuration" },
      });
      return redirectBack();
    }

    const locked = await db.callJob.updateMany({
      where: { id: callJobId, shop, status: "QUEUED" },
      data: { status: "CALLING", attempts: { increment: 1 }, provider: "vapi", outcome: null },
    });
    if (locked.count === 0) return redirectBack();

    try {
      await createVapiCallForJob({ shop, callJobId });
      await db.callJob.updateMany({
        where: { id: callJobId, shop },
        data: { status: "CALLING", outcome: "CALL_STARTED" },
      });
    } catch (e: any) {
      const settings = await ensureSettings(shop);
      const maxAttempts = settings.maxAttempts ?? 2;

      const fresh = await db.callJob.findUnique({ where: { id: callJobId }, select: { attempts: true } });
      const attemptsAfter = Number(fresh?.attempts ?? 0);

      if (attemptsAfter >= maxAttempts) {
        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: { status: "FAILED", outcome: `ERROR: ${String(e?.message ?? e)}` },
        });
      } else {
        const retryMinutes = settings.retryMinutes ?? 180;
        const next = new Date(Date.now() + retryMinutes * 60 * 1000);
        await db.callJob.updateMany({
          where: { id: callJobId, shop },
          data: {
            status: "QUEUED",
            scheduledFor: next,
            outcome: `RETRY_SCHEDULED in ${retryMinutes}m`,
          },
        });
      }
    }

    return redirectBack();
  }

  return redirectBack();
};

function statusTone(status: string) {
  const value = safeStr(status).toUpperCase();
  if (value === "COMPLETED") return "success" as const;
  if (value === "CALLING") return "info" as const;
  if (value === "QUEUED") return "attention" as const;
  if (value === "FAILED") return "critical" as const;
  return undefined;
}

function outcomeTone(outcome: string | null) {
  const value = safeStr(outcome).toLowerCase();
  if (value.includes("recovered") || value.includes("converted") || value.includes("success")) return "success" as const;
  if (value.includes("needs_followup") || value.includes("follow") || value.includes("voicemail")) return "attention" as const;
  if (value.includes("no_answer") || value.includes("failed") || value.includes("not_interested")) return "critical" as const;
  return undefined;
}

function displayOutcome(value: string | null) {
  if (!value) return "—";
  return value.replace(/_/g, " ").toUpperCase();
}

function StatCard({ label, value, help }: { label: string; value: number; help: string }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="headingXl">
          {String(value)}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {help}
        </Text>
      </BlockStack>
    </Card>
  );
}

export default function Calls() {
  const { shop, providerConfigured, stats, rows } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  React.useEffect(() => {
    const active = stats.calling > 0 || stats.queued > 0;
    if (!active) return;
    const id = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(id);
  }, [stats.calling, stats.queued, revalidator]);

  const [selectedId, setSelectedId] = React.useState<string | null>(rows?.[0]?.id ?? null);

  React.useEffect(() => {
    if (!selectedId && rows?.[0]?.id) setSelectedId(rows[0].id);
  }, [selectedId, rows]);

  const selected = React.useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

  return (
    <Page
      title="Call activity"
      subtitle="Monitor queued calls, live calls, AI outcomes and follow-up intelligence"
      titleMetadata={
        <Badge tone={providerConfigured ? "success" : "attention"}>
          {providerConfigured ? "Provider ready" : "Simulation mode"}
        </Badge>
      }
      backAction={{ content: "Dashboard", url: "/app/dashboard" }}
    >
      <BlockStack gap="500">
        {!providerConfigured ? (
          <Banner tone="warning" title="Call provider is not fully configured">
            <p>Calls will not use the live provider until the required provider settings are available.</p>
          </Banner>
        ) : null}

        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Live queue
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {shop} · refreshes automatically every 5 seconds while calls are active
              </Text>
            </BlockStack>
            <InlineStack gap="200">
              <Form method="post">
                <input type="hidden" name="intent" value="run_jobs" />
                <Button submit variant="primary" disabled={stats.queued === 0}>
                  Run queued jobs
                </Button>
              </Form>
              <Button onClick={() => revalidator.revalidate()}>Refresh</Button>
            </InlineStack>
          </InlineStack>
        </Card>

        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <StatCard label="Queued" value={stats.queued} help="Waiting for their scheduled call time" />
          <StatCard label="Calling now" value={stats.calling} help="Currently in progress with the provider" />
          <StatCard label="Completed" value={stats.completed7d} help="Completed during the last 7 days" />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Recent calls
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Select any call to inspect the AI summary and next action.
                  </Text>
                </BlockStack>
              </Box>

              <IndexTable
                resourceName={{ singular: "call", plural: "calls" }}
                itemCount={rows.length}
                selectable={false}
                headings={[
                  { title: "Checkout" },
                  { title: "Status" },
                  { title: "Outcome" },
                  { title: "AI outcome" },
                  { title: "Scheduled" },
                  { title: "Attempts" },
                  { title: "Recording" },
                ]}
                emptyState={
                  <Box padding="600">
                    <Text as="p" alignment="center" tone="subdued">
                      No call jobs yet.
                    </Text>
                  </Box>
                }
              >
                {rows.map((row, index) => (
                  <IndexTable.Row id={row.id} key={row.id} position={index}>
                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        <Button variant="plain" textAlign="left" onClick={() => setSelectedId(row.id)}>
                          {row.checkoutId}
                        </Button>
                        {row.id === selectedId ? <Badge tone="info">Selected</Badge> : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={statusTone(row.status)}>{safeStr(row.status).toUpperCase()}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={outcomeTone(row.callOutcome)}>{displayOutcome(row.callOutcome)}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        <Badge tone={outcomeTone(row.openaiOutcome)}>{displayOutcome(row.openaiOutcome)}</Badge>
                        {row.aiStatus ? (
                          <Text as="span" variant="bodySm" tone="subdued">
                            AI: {safeStr(row.aiStatus).toUpperCase()}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        <Text as="span" variant="bodySm">
                          {formatWhen(row.scheduledFor)}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          Created {formatWhen(row.createdAt)}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{String(row.attempts)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.recordingUrl ? (
                        <Button url={row.recordingUrl} external variant="plain" size="slim">
                          Open
                        </Button>
                      ) : (
                        <Text as="span" tone="subdued">
                          —
                        </Text>
                      )}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Call intelligence
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {selected ? `Checkout ${selected.checkoutId}` : "Select a call from the table"}
                  </Text>
                </BlockStack>

                {selected ? (
                  <>
                    <InlineStack gap="200">
                      <Badge tone={statusTone(selected.status)}>{safeStr(selected.status).toUpperCase()}</Badge>
                      <Badge tone={outcomeTone(selected.openaiOutcome)}>{displayOutcome(selected.openaiOutcome)}</Badge>
                    </InlineStack>

                    <Divider />

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        AI summary
                      </Text>
                      <Text as="p" variant="bodyMd" tone={selected.summary ? undefined : "subdued"}>
                        {selected.summary || "No summary available yet."}
                      </Text>
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Next best action
                      </Text>
                      <Text as="p" variant="bodyMd" tone={selected.nextAction ? undefined : "subdued"}>
                        {selected.nextAction || "No next action available yet."}
                      </Text>
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Follow-up message
                      </Text>
                      <Box background="bg-surface-secondary" borderRadius="300" padding="300">
                        <Text as="p" variant="bodySm" tone={selected.followUp ? undefined : "subdued"}>
                          {selected.followUp || "No follow-up message available."}
                        </Text>
                      </Box>
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Provider call
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {selected.providerCallId || "No provider call ID yet"}
                      </Text>
                      {selected.recordingUrl ? (
                        <Button url={selected.recordingUrl} external>
                          Open recording
                        </Button>
                      ) : null}
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        System prompt used
                      </Text>
                      <Box background="bg-surface-secondary" borderRadius="300" padding="300">
                        <Text as="p" variant="bodySm" tone={selected.sentSystemPrompt ? undefined : "subdued"}>
                          {selected.sentSystemPrompt || "Prompt data is not available for this call."}
                        </Text>
                      </Box>
                    </BlockStack>

                    <Form method="post">
                      <input type="hidden" name="intent" value="manual_call" />
                      <input type="hidden" name="callJobId" value={selected.id} />
                      <Button submit fullWidth variant="primary" disabled={selected.status !== "QUEUED"}>
                        Call now
                      </Button>
                    </Form>
                  </>
                ) : (
                  <Box paddingBlock="500">
                    <Text as="p" alignment="center" tone="subdued">
                      Choose a call to see its summary, provider details, next action and follow-up message.
                    </Text>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
