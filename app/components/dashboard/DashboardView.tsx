// app/components/dashboard/DashboardView.tsx
import * as React from "react";
import { Form } from "react-router";
import {
  Badge,
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
} from "@shopify/polaris";

type BadgeTone = "success" | "info" | "warning" | "critical" | "new";

export type DashboardViewProps = {
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
  const keyMetricOrder: DashboardViewProps["metrics"][number]["key"][] = [
    "recovered_revenue",
    "at_risk_eligible_revenue",
    "win_rate",
    "abandoned_eligible_count",
  ];

  const keyMetrics = keyMetricOrder
    .map((key) => props.metrics.find((metric) => metric.key === key))
    .filter(Boolean) as DashboardViewProps["metrics"];

  const visibleMetrics = keyMetrics.length >= 3 ? keyMetrics.slice(0, 4) : props.metrics.slice(0, 4);
  const visiblePriorities = props.priorities.filter((row) => row.count > 0).slice(0, 4);
  const visibleActivity = props.liveRows.slice(0, 5);
  const visibleRecoveries = props.recentRecoveries.slice(0, 5);

  const priorityRows = visiblePriorities.map((row, index) => (
    <IndexTable.Row id={row.key} key={row.key} position={index}>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <Text as="span" variant="bodyMd" fontWeight="medium">
            {row.label}
          </Text>
          {row.nextBestAction ? (
            <Text as="span" variant="bodySm" tone="subdued">
              {row.nextBestAction}
            </Text>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={badgeTone(row.tone)}>{String(row.count)}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Button url={row.href} variant="plain" size="slim">
          Review
        </Button>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

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
      title="CheckoutCall AI"
      subtitle="Your abandoned checkout recovery at a glance"
      titleMetadata={
        <Badge tone={props.settings.enabled ? "success" : "info"}>
          {props.settings.enabled ? "Automation active" : "Automation paused"}
        </Badge>
      }
      primaryAction={{ content: "View checkouts", url: props.nav.checkoutsHref }}
      secondaryActions={[{ content: "Call activity", url: props.nav.callsHref }]}
    >
      <BlockStack gap="400">
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
            {props.canCreateTestCall ? (
              <Form method="post">
                <input type="hidden" name="intent" value="create_test_call" />
                <Button submit>Test call</Button>
              </Form>
            ) : null}
          </InlineStack>
        </InlineStack>

        {props.hero.show ? (
          <Card>
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
          </Card>
        ) : null}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
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
            <IndexTable
              resourceName={{ singular: "priority", plural: "priorities" }}
              itemCount={visiblePriorities.length}
              headings={[{ title: "Item" }, { title: "Count" }, { title: "" }]}
              selectable={false}
              emptyState={
                <Box padding="500">
                  <Text as="p" tone="subdued" alignment="center">
                    Nothing needs your attention right now.
                  </Text>
                </Box>
              }
            >
              {priorityRows}
            </IndexTable>
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
