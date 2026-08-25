import * as React from "react";
import { Form, useRevalidator, useSearchParams } from "react-router";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  Thumbnail,
} from "@shopify/polaris";

export type CallActivityRow = {
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
  customerName: string | null;
  phone: string | null;
  email: string | null;
  cartTotal: number;
  currency: string;
  thumbUrl: string | null;
  cartPreview: string | null;
  offerCode: string | null;
  offerType: string | null;
  offerPercent: number | null;
  smsSentAt: string | null;
  smsMessageId: string | null;
  recoveredOrderId: string | null;
  recoveredAmount: number | null;
  recoveredFinancial: string | null;
};

type Props = {
  stats: { queued: number; calling: number; completed7d: number };
  rows: CallActivityRow[];
  providerConfigured: boolean;
};

type CallFilter = "all" | "queued" | "calling" | "completed" | "failed";

const s = (v: unknown) => (v == null ? "" : String(v).trim());
const shortId = (v: string) => (s(v).length > 12 ? `…${s(v).slice(-10)}` : s(v) || "—");
const when = (v: string | null | undefined) => {
  const d = new Date(s(v));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};
const money = (v: number | null | undefined, c: string) => {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: s(c).toUpperCase() || "USD",
      maximumFractionDigits: 2,
    }).format(Number(v ?? 0));
  } catch {
    return `${Number(v ?? 0).toFixed(2)} ${c || "USD"}`;
  }
};

function statusTone(v: string) {
  const x = s(v).toUpperCase();
  if (x === "COMPLETED") return "success" as const;
  if (x === "CALLING") return "info" as const;
  if (x === "QUEUED") return "attention" as const;
  if (x === "FAILED") return "critical" as const;
  return undefined;
}

function outcomeTone(v: string | null) {
  const x = s(v).toLowerCase();
  if (x.includes("recovered") || x.includes("converted")) return "success" as const;
  if (x.includes("follow") || x.includes("voicemail")) return "attention" as const;
  if (x.includes("no_answer") || x.includes("failed") || x.includes("not_interested")) return "critical" as const;
  return undefined;
}

const outcomeLabel = (v: string | null) =>
  s(v) ? s(v).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "No outcome yet";

function Metric({ label, value, help }: { label: string; value: number; help: string }) {
  return (
    <Card>
      <BlockStack gap="150">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="headingLg">{String(value)}</Text>
        <Text as="p" variant="bodySm" tone="subdued">{help}</Text>
      </BlockStack>
    </Card>
  );
}

function ProductThumb({ row, size = "small" }: { row: CallActivityRow; size?: "small" | "medium" }) {
  if (row.thumbUrl) return <Thumbnail source={row.thumbUrl} alt={row.cartPreview || "Cart item"} size={size} />;
  return (
    <Box background="bg-surface-secondary" borderRadius="200" padding="200">
      <Text as="span" variant="bodySm" tone="subdued">No image</Text>
    </Box>
  );
}

export function CallActivityView({ stats, rows, providerConfigured }: Props) {
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const requestedFilter = s(searchParams.get("tab")).toLowerCase();
  const filter: CallFilter =
    requestedFilter === "queued" ||
    requestedFilter === "calling" ||
    requestedFilter === "completed" ||
    requestedFilter === "failed"
      ? (requestedFilter as CallFilter)
      : requestedFilter === "ai_errors"
        ? "failed"
        : "all";

  const filteredRows = React.useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((row) => s(row.status).toLowerCase() === filter);
  }, [rows, filter]);

  const shown = filteredRows.slice(0, 30);
  const [selectedId, setSelectedId] = React.useState<string | null>(shown[0]?.id ?? null);

  React.useEffect(() => {
    if (!shown.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !shown.some((r) => r.id === selectedId)) setSelectedId(shown[0].id);
  }, [shown, selectedId]);

  React.useEffect(() => {
    if (stats.calling <= 0 && stats.queued <= 0) return;
    const t = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(t);
  }, [stats.calling, stats.queued, revalidator]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const changeFilter = React.useCallback(
    (next: CallFilter) => {
      const copy = new URLSearchParams(searchParams);
      if (next === "all") copy.delete("tab");
      else copy.set("tab", next);
      setSearchParams(copy);
    },
    [searchParams, setSearchParams],
  );

  return (
    <Page
      title="Calls"
      subtitle="See who the AI contacted, what was offered and what should happen next."
      backAction={{ content: "Dashboard", url: "/app/dashboard" }}
    >
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Recovery calls</Text>
              <Text as="p" variant="bodySm" tone="subdued">Select a customer to see the cart, offer and call result.</Text>
            </BlockStack>
            <InlineStack gap="200">
              <Form method="post">
                <input type="hidden" name="intent" value="run_jobs" />
                <Button submit variant="primary" disabled={stats.queued === 0 || !providerConfigured}>Run queued calls</Button>
              </Form>
              <Button onClick={() => revalidator.revalidate()} loading={revalidator.state === "loading"}>Refresh</Button>
            </InlineStack>
          </InlineStack>
        </Card>

        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
          <Metric label="Waiting" value={stats.queued} help="Scheduled calls" />
          <Metric label="Calling now" value={stats.calling} help="Live conversations" />
          <Metric label="Completed" value={stats.completed7d} help="Last 7 days" />
        </InlineGrid>

        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <ButtonGroup variant="segmented">
            <Button pressed={filter === "all"} onClick={() => changeFilter("all")}>All</Button>
            <Button pressed={filter === "queued"} onClick={() => changeFilter("queued")}>Waiting</Button>
            <Button pressed={filter === "calling"} onClick={() => changeFilter("calling")}>Calling</Button>
            <Button pressed={filter === "completed"} onClick={() => changeFilter("completed")}>Completed</Button>
            <Button pressed={filter === "failed"} onClick={() => changeFilter("failed")}>Failed</Button>
          </ButtonGroup>
          <Text as="p" variant="bodySm" tone="subdued">Showing {shown.length} of {filteredRows.length}</Text>
        </InlineStack>

        <InlineGrid columns={{ xs: 1, lg: "2fr 1fr" }} gap="400">
          <Card padding="0">
            <Box padding="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Recent calls</Text>
                <Text as="p" variant="bodySm" tone="subdued">Customer, cart, offer and result in one place.</Text>
              </BlockStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "call", plural: "calls" }}
              itemCount={shown.length}
              selectable={false}
              headings={[{ title: "Customer" }, { title: "Cart" }, { title: "Call" }, { title: "Offer" }, { title: "When" }, { title: "" }]}
              emptyState={<Box padding="600"><Text as="p" alignment="center" tone="subdued">No calls in this view.</Text></Box>}
            >
              {shown.map((r, i) => (
                <IndexTable.Row id={r.id} key={r.id} position={i}>
                  <IndexTable.Cell>
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <ProductThumb row={r} />
                      <BlockStack gap="050">
                        <Button variant="plain" textAlign="left" onClick={() => setSelectedId(r.id)}>{r.customerName || "Guest customer"}</Button>
                        <Text as="span" variant="bodySm" tone="subdued">{r.phone || r.email || `Checkout ${shortId(r.checkoutId)}`}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">Checkout {shortId(r.checkoutId)}</Text>
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">{money(r.cartTotal, r.currency)}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">{r.cartPreview || "Cart details unavailable"}</Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="100">
                      <div><Badge tone={statusTone(r.status)}>{s(r.status).toUpperCase()}</Badge></div>
                      <Text as="span" variant="bodySm" tone="subdued">{outcomeLabel(r.openaiOutcome || r.callOutcome)}</Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {r.offerCode ? (
                      <BlockStack gap="050">
                        <div><Badge tone="success">{r.offerCode}</Badge></div>
                        <Text as="span" variant="bodySm">{r.offerPercent ? `${r.offerPercent}% off` : "Offer"}</Text>
                        <Text as="span" variant="bodySm" tone={r.smsSentAt ? "success" : "subdued"}>{r.smsSentAt ? "SMS sent" : "SMS not sent"}</Text>
                      </BlockStack>
                    ) : <Text as="span" variant="bodySm" tone="subdued">No offer</Text>}
                  </IndexTable.Cell>
                  <IndexTable.Cell><Text as="span" variant="bodySm">{when(r.scheduledFor)}</Text></IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button onClick={() => setSelectedId(r.id)} size="slim" variant={r.id === selectedId ? "primary" : "secondary"}>
                      {r.id === selectedId ? "Selected" : "View"}
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>

          <Card>
            {selected ? (
              <BlockStack gap="350">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Customer & checkout</Text>
                  <Badge tone={statusTone(selected.status)}>{s(selected.status).toUpperCase()}</Badge>
                </InlineStack>
                <BlockStack gap="050">
                  <Text as="p" variant="headingSm">{selected.customerName || "Guest customer"}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{selected.phone || "No phone"}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{selected.email || "No email"}</Text>
                </BlockStack>
                <Divider />
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <ProductThumb row={selected} size="medium" />
                  <BlockStack gap="100">
                    <Text as="p" variant="headingMd">{money(selected.cartTotal, selected.currency)}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">{selected.cartPreview || "Cart details unavailable"}</Text>
                  </BlockStack>
                </InlineStack>

                {selected.offerCode || selected.smsSentAt ? (
                  <Box background="bg-surface-secondary" borderRadius="300" padding="300">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">Offer & SMS</Text>
                      <InlineStack gap="150">
                        {selected.offerCode ? <Badge tone="success">Coupon {selected.offerCode}</Badge> : null}
                        {selected.offerPercent ? <Badge tone="info">{selected.offerPercent}% off</Badge> : null}
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone={selected.smsSentAt ? "success" : "subdued"}>
                        {selected.smsSentAt ? `SMS sent ${when(selected.smsSentAt)}` : "SMS not sent"}
                      </Text>
                    </BlockStack>
                  </Box>
                ) : null}

                {selected.recoveredOrderId ? (
                  <Box background="bg-surface-success" borderRadius="300" padding="300">
                    <BlockStack gap="100">
                      <Badge tone="success">Recovered order</Badge>
                      <Text as="p" variant="headingSm">Order {selected.recoveredOrderId}</Text>
                      <Text as="p">{money(selected.recoveredAmount ?? selected.cartTotal, selected.currency)}</Text>
                    </BlockStack>
                  </Box>
                ) : null}

                <BlockStack gap="100">
                  <InlineStack gap="150">
                    <Text as="h3" variant="headingSm">Call result</Text>
                    <Badge tone={outcomeTone(selected.openaiOutcome || selected.callOutcome)}>{outcomeLabel(selected.openaiOutcome || selected.callOutcome)}</Badge>
                  </InlineStack>
                  <Text as="p" tone={selected.summary ? undefined : "subdued"}>{selected.summary || "The AI summary will appear after processing."}</Text>
                </BlockStack>

                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">Next step</Text>
                  <Text as="p" tone={selected.nextAction ? undefined : "subdued"}>{selected.nextAction || "No follow-up required right now."}</Text>
                </BlockStack>

                <InlineStack gap="200">
                  {selected.recordingUrl ? <Button url={selected.recordingUrl} external>Recording</Button> : null}
                  <Form method="post">
                    <input type="hidden" name="intent" value="manual_call" />
                    <input type="hidden" name="callJobId" value={selected.id} />
                    <Button submit variant="primary" disabled={selected.status !== "QUEUED" || !providerConfigured}>Call now</Button>
                  </Form>
                </InlineStack>
              </BlockStack>
            ) : <Box paddingBlock="800"><Text as="p" alignment="center" tone="subdued">Select a call to see details.</Text></Box>}
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
