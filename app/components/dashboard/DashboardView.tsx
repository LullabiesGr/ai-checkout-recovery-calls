// app/components/dashboard/DashboardView.tsx
import { useState } from "react";
import { Form, useNavigation } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  TextField,
  Modal,
  Select,
  FormLayout,
} from "@shopify/polaris";

type BadgeTone = "success" | "info" | "warning" | "critical" | "new";

export type DashboardViewProps = {
  testCallId?: string;
  actionResult?: { ok: boolean; message: string };
  shopLabel?: string;

  nav: {
    checkoutsHref: string;
    callsHref: string;
  };

  range: {
    key: "all" | "7d" | "24h";
    label: string;
    links: { all: string; d7: string; h24: string };
  };

  hero:
    | { show: false }
    | {
        show: true;
        recoveredRevenueText: string;
        recoveredCount: number;
        winRate: number;
        href: string;
      };

  metrics: Array<{
    key:
      | "recovered_revenue"
      | "at_risk_eligible_revenue"
      | "win_rate"
      | "abandoned_eligible_count"
      | "calls_completed"
      | "followups_needed"
      | "discount_requests";
    label: string;
    valueText: string;
    tone: BadgeTone;
    deltaText: string | null;
    href: string;
  }>;

  pipelineRows: Array<{
    key: string;
    label: string;
    count: number;
    tone: BadgeTone;
    href: string;
  }>;

  liveRows: Array<{
    key: string;
    event: string;
    status: string;
    tone: BadgeTone;
    whenText: string;
    statusHint?: string;
    recordingUrl?: string;
    logUrl?: string;
  }>;

  priorities: Array<{
    key: string;
    label: string;
    count: number;
    rawCountText?: string;
    nextBestAction?: string;
    href: string;
    tone: BadgeTone;
  }>;

  recentRecoveries: Array<{
    checkoutId: string;
    customerName: string;
    amountText: string;
    whenText: string;
    recoveredOrderId: string;
    href: string;
  }>;

  blockers: {
    total: number;
    rows: Array<{
      key: string;
      label: string;
      count: number;
      pct: number | null;
      tone: BadgeTone;
    }>;
  };

  settings: {
    enabled: boolean;
    vapiReady: boolean;
    criticalMissing: boolean;
    rows: Array<{ label: string; value: string; tone: BadgeTone }>;
  };

  canCreateTestCall: boolean;
};

function displayActivityStatus(value: string) {
  const v = String(value ?? "").trim().toUpperCase();
  const known: Record<string, string> = {
    NEEDS_FOLLOWUP: "Needs follow-up",
    ORDER_RECOVERED: "Order recovered",
    HIGH_INTENT: "High intent",
    NO_ANSWER: "No answer",
    AI_ERROR: "Needs review",
    NOT_RECOVERED: "Not recovered",
    COMPLETED: "Completed",
    CALLING: "Calling",
    QUEUED: "Waiting",
    FAILED: "Failed",
    ERROR: "Needs review",
    VOICEMAIL: "Voicemail",
  };
  return known[v] ?? (v ? v.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()) : "Update");
}

function badgeTone(tone: BadgeTone) {
  if (tone === "warning") return "attention" as const;
  return tone;
}

function friendlyMetricLabel(key: DashboardViewProps["metrics"][number]["key"], fallback: string) {
  switch (key) {
    case "recovered_revenue":
      return "Revenue recovered";
    case "at_risk_eligible_revenue":
      return "Revenue to recover";
    case "win_rate":
      return "Recovery rate";
    case "abandoned_eligible_count":
      return "Open checkouts";
    case "calls_completed":
      return "Calls completed";
    case "followups_needed":
      return "Needs follow-up";
    case "discount_requests":
      return "Discount requests";
    default:
      return fallback;
  }
}

function MetricCard({ metric }: { metric: DashboardViewProps["metrics"][number] }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" tone="subdued">
          {friendlyMetricLabel(metric.key, metric.label)}
        </Text>
        <Text as="p" variant="headingXl">
          {metric.valueText}
        </Text>
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text as="span" variant="bodySm" tone="subdued">
            {metric.deltaText || "Current period"}
          </Text>
          <Button url={metric.href} variant="plain" size="slim">
            View
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export function DashboardView(props: DashboardViewProps) {
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testName, setTestName] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testCurrency, setTestCurrency] = useState("EUR");
  const [testItems, setTestItems] = useState([{ title: "", quantity: "1", price: "" }]);
  const updateItem = (index: number, field: "title" | "quantity" | "price", value: string) => setTestItems(items => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  const testTotal = testItems.reduce((total, item) => total + (Number(item.quantity) || 0) * (Number(item.price.replace(",", ".")) || 0), 0);
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const keyMetricOrder: DashboardViewProps["metrics"][number]["key"][] = [
    "recovered_revenue",
    "at_risk_eligible_revenue",
    "win_rate",
    "abandoned_eligible_count",
  ];

  const keyMetrics = keyMetricOrder
    .map((key) => props.metrics.find((metric) => metric.key === key))
    .filter(Boolean) as DashboardViewProps["metrics"];

  const visibleMetrics = (keyMetrics.length >= 3 ? keyMetrics : props.metrics)
    .filter((metric) => !props.hero.show || metric.key !== "recovered_revenue").slice(0, 4);
  const visiblePriorities = props.priorities.filter((row) => row.count > 0).slice(0, 4);
  const visibleActivity = props.liveRows.slice(0, 5);
  const visibleRecoveries = props.recentRecoveries.slice(0, 5);

  const activityRows = visibleActivity.map((row, index) => (
    <IndexTable.Row id={row.key} key={row.key} position={index}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="medium">
          {row.event}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={badgeTone(row.tone)}>{displayActivityStatus(row.status)}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {row.whenText}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const recoveryRows = visibleRecoveries.map((row, index) => (
    <IndexTable.Row id={row.checkoutId} key={row.checkoutId} position={index}>
      <IndexTable.Cell>
        <Button url={row.href} variant="plain" textAlign="left">
          {row.customerName || `Checkout ${row.checkoutId}`}
        </Button>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" fontWeight="semibold">
          {row.amountText}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {row.whenText}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm">{row.recoveredOrderId || "—"}</Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      fullWidth
      title="CartEcho"
      subtitle="Bring customers back. Turn conversations into recovered orders."
      titleMetadata={
        <Badge tone={props.settings.enabled ? "success" : "info"}>
          {props.settings.enabled ? "Automation active" : "Automation paused"}
        </Badge>
      }
      primaryAction={{ content: "View checkouts", url: props.nav.checkoutsHref }}
      secondaryActions={[{ content: "Call activity", url: props.nav.callsHref }]}
    >
      <Modal open={testOpen} onClose={() => !submitting && setTestOpen(false)} title="Simulate a checkout recovery call">
        <Modal.Section>
          <Form method="post">
            <input type="hidden" name="intent" value="create_test_call" />
            <input type="hidden" name="testCallId" value={props.testCallId} />
            <input type="hidden" name="items" value={JSON.stringify(testItems)} />
            <BlockStack gap="400">
              <Text as="p">The agent uses your current automation settings and the customer and cart details below. This places a real call to your test number and uses one attempt. It does not create a Shopify order.</Text>
              {props.actionResult ? <Banner tone={props.actionResult.ok ? "success" : "critical"}><p>{props.actionResult.message}</p></Banner> : null}
              <FormLayout>
                <TextField label="Customer name" name="customerName" value={testName} onChange={setTestName} autoComplete="name" requiredIndicator disabled={submitting} />
                <TextField label="Your test phone number" type="tel" name="phone" value={testPhone} onChange={setTestPhone} autoComplete="tel" placeholder="+306900000000" helpText="Include the country code." requiredIndicator disabled={submitting} />
                <TextField label="Email (optional)" type="email" name="email" value={testEmail} onChange={setTestEmail} autoComplete="email" disabled={submitting} />
                <Select label="Currency" name="currency" options={["EUR", "USD", "GBP", "CAD", "AUD"]} value={testCurrency} onChange={setTestCurrency} disabled={submitting} />
              </FormLayout>
              <Text as="h3" variant="headingSm">Cart products</Text>
              {testItems.map((item, index) => <Box key={index} padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="300">
                  <TextField label={`Product ${index + 1}`} value={item.title} onChange={value => updateItem(index, "title", value)} autoComplete="off" disabled={submitting} />
                  <InlineGrid columns={2} gap="300">
                    <TextField label="Quantity" type="number" min={1} max={1000} value={item.quantity} onChange={value => updateItem(index, "quantity", value)} autoComplete="off" disabled={submitting} />
                    <TextField label="Unit price" type="number" min={0.01} step={0.01} suffix={testCurrency} value={item.price} onChange={value => updateItem(index, "price", value)} autoComplete="off" disabled={submitting} />
                  </InlineGrid>
                  {testItems.length > 1 ? <Button tone="critical" variant="plain" disabled={submitting} onClick={() => setTestItems(items => items.filter((_, i) => i !== index))}>Remove product</Button> : null}
                </BlockStack>
              </Box>)}
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <Button disabled={submitting || testItems.length >= 10} onClick={() => setTestItems(items => [...items, { title: "", quantity: "1", price: "" }])}>Add product</Button>
                <Text as="p" fontWeight="semibold">Cart total: {testTotal.toFixed(2)} {testCurrency}</Text>
              </InlineStack>
              <InlineStack align="end" gap="200">
                <Button disabled={submitting} onClick={() => setTestOpen(false)}>Close</Button>
                <Button submit variant="primary" loading={submitting} disabled={submitting || !testName.trim() || !testPhone.trim()}>Start test call</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Modal.Section>
      </Modal>
      <BlockStack gap="400">
        {props.actionResult ? <Banner tone={props.actionResult.ok ? "success" : "critical"}><p>{props.actionResult.message}</p></Banner> : null}
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <ButtonGroup variant="segmented">
            <Button url={props.range.links.all} pressed={props.range.key === "all"}>
              All time
            </Button>
            <Button url={props.range.links.d7} pressed={props.range.key === "7d"}>
              7 days
            </Button>
            <Button url={props.range.links.h24} pressed={props.range.key === "24h"}>
              24 hours
            </Button>
          </ButtonGroup>

          <InlineStack gap="200">
            <Form method="post">
              <input type="hidden" name="intent" value="sync_now" />
              <Button submit>Refresh</Button>
            </Form>
            {props.canCreateTestCall ? <Button onClick={() => setTestOpen(true)}>Test call</Button> : null}
          </InlineStack>
        </InlineStack>

        {props.hero.show ? (
          <div className="ce-revenue-hero">
            <span className="ce-eyebrow">RECOVERY OVERVIEW</span>
            <InlineStack align="space-between" blockAlign="center" gap="400">
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Recovered revenue · {props.range.label}
                </Text>
                <Text as="p" variant="heading2xl">
                  {props.hero.recoveredRevenueText}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {props.hero.recoveredCount} completed purchases recovered · {props.hero.winRate}% recovery rate
                </Text>
              </BlockStack>
              <Button url={props.hero.href}>View recovered orders</Button>
            </InlineStack>
          </div>
        ) : null}

        <InlineGrid columns={{ xs: 1, sm: 2, md: visibleMetrics.length }} gap="300">
          {visibleMetrics.map((metric) => (
            <MetricCard key={metric.key} metric={metric} />
          ))}
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card padding="0">
            <Box padding="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Needs your attention
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Only the recovery items worth checking now.
                </Text>
              </BlockStack>
            </Box>
            <div className="ce-priorities">
              {visiblePriorities.length ? visiblePriorities.map((row) => (
                <div className="ce-priority" key={row.key}>
                  <div className="ce-priority-copy">
                    <Text as="h3" variant="headingSm">{row.label}</Text>
                    {row.nextBestAction ? <Text as="p" tone="subdued">{row.nextBestAction}</Text> : null}
                  </div>
                  <Badge tone={badgeTone(row.tone)}>{String(row.count)}</Badge>
                  <Button url={row.href} accessibilityLabel={`Review ${row.label.toLowerCase()}`}>Review</Button>
                </div>
              )) : <Box padding="500"><Text as="p" tone="subdued">You’re all caught up. Nothing needs your attention.</Text></Box>}
            </div>
          </Card>

          <Card padding="0">
            <Box padding="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Recent activity
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Latest calls and recovery activity.
                </Text>
              </BlockStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "activity", plural: "activities" }}
              itemCount={visibleActivity.length}
              headings={[{ title: "Activity" }, { title: "Status" }, { title: "When" }]}
              selectable={false}
              emptyState={
                <Box padding="500">
                  <Text as="p" tone="subdued" alignment="center">
                    Activity will appear here as recovery starts.
                  </Text>
                </Box>
              }
            >
              {activityRows}
            </IndexTable>
            {props.liveRows.length > visibleActivity.length ? (
              <Box padding="300">
                <Button url={props.nav.callsHref} variant="plain">
                  View all call activity
                </Button>
              </Box>
            ) : null}
          </Card>
        </InlineGrid>

        {visibleRecoveries.length > 0 ? (
          <Card padding="0">
            <Box padding="400">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Recent recovered orders
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Purchases that were actually completed after abandonment.
                  </Text>
                </BlockStack>
                <Button url={props.nav.checkoutsHref} variant="plain">
                  View all
                </Button>
              </InlineStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "recovery", plural: "recoveries" }}
              itemCount={visibleRecoveries.length}
              headings={[{ title: "Customer" }, { title: "Recovered" }, { title: "When" }, { title: "Order" }]}
              selectable={false}
            >
              {recoveryRows}
            </IndexTable>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
