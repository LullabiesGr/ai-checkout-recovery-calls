// app/components/dashboard/DashboardView.tsx
import * as React from "react";
import { Form } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
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

function badgeTone(tone: BadgeTone) {
  if (tone === "warning") return "attention" as const;
  return tone;
}

function shouldHideSettingRowLabel(label: string) {
  const s = (label || "").toLowerCase().trim();
  return (
    s.includes("assistant id") ||
    s.includes("phone number id") ||
    s.includes("phone_number_id") ||
    s.includes("assistant_id") ||
    s.includes("vapi")
  );
}

function MetricCard({
  label,
  valueText,
  tone,
  deltaText,
  href,
}: {
  label: string;
  valueText: string;
  tone: BadgeTone;
  deltaText?: string | null;
  href: string;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
          <Text as="p" variant="headingLg">
            {valueText}
          </Text>
          <Badge tone={badgeTone(tone)}>{tone === "new" ? "NEW" : tone.toUpperCase()}</Badge>
        </InlineStack>
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text as="span" variant="bodySm" tone="subdued">
            {deltaText || "Current range"}
          </Text>
          <Button url={href} variant="plain" size="slim">
            View
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <BlockStack gap="100">
      <Text as="h2" variant="headingMd">
        {title}
      </Text>
      {subtitle ? (
        <Text as="p" variant="bodySm" tone="subdued">
          {subtitle}
        </Text>
      ) : null}
    </BlockStack>
  );
}

export function DashboardView(props: DashboardViewProps) {
  const settingsRows = React.useMemo(
    () => (props.settings.rows || []).filter((r) => !shouldHideSettingRowLabel(r.label)),
    [props.settings.rows],
  );

  const rangeButtons = (
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
  );

  const liveRows = props.liveRows.map((row, index) => (
    <IndexTable.Row id={row.key} key={row.key} position={index}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="medium">
          {row.event}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <div>
            <Badge tone={badgeTone(row.tone)}>{row.status}</Badge>
          </div>
          {row.statusHint ? (
            <Text as="span" variant="bodySm" tone="subdued">
              {row.statusHint}
            </Text>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {row.whenText}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" wrap={false}>
          {row.recordingUrl ? (
            <Button url={row.recordingUrl} external variant="plain" size="slim">
              Recording
            </Button>
          ) : (
            <Text as="span" tone="subdued">
              —
            </Text>
          )}
          {row.logUrl ? (
            <Button url={row.logUrl} external variant="plain" size="slim">
              Logs
            </Button>
          ) : null}
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const priorityRows = props.priorities.map((row, index) => (
    <IndexTable.Row id={row.key} key={row.key} position={index}>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <Text as="span" variant="bodyMd" fontWeight="medium">
            {row.label}
          </Text>
          {row.rawCountText ? (
            <Text as="span" variant="bodySm" tone="subdued">
              {row.rawCountText}
            </Text>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={badgeTone(row.tone)}>{String(row.count)}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone={row.nextBestAction ? undefined : "subdued"}>
          {row.nextBestAction || "No action needed"}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Button url={row.href} variant="plain" size="slim">
          Review
        </Button>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const recoveryRows = props.recentRecoveries.map((row, index) => (
    <IndexTable.Row id={row.checkoutId} key={row.checkoutId} position={index}>
      <IndexTable.Cell>
        <BlockStack gap="100">
          <Button url={row.href} variant="plain" textAlign="left">
            {row.customerName || `Checkout ${row.checkoutId}`}
          </Button>
          <Text as="span" variant="bodySm" tone="subdued">
            #{row.checkoutId}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone="success">{row.amountText}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {row.whenText}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm">
          {row.recoveredOrderId}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="CheckoutCall AI"
      subtitle="Abandoned checkout recovery powered by AI voice calls"
      titleMetadata={
        <Badge tone={props.settings.enabled && props.settings.vapiReady ? "success" : "attention"}>
          {props.settings.enabled && props.settings.vapiReady ? "Automation live" : "Needs attention"}
        </Badge>
      }
      primaryAction={{ content: "View checkouts", url: props.nav.checkoutsHref }}
      secondaryActions={[{ content: "Call activity", url: props.nav.callsHref }]}
    >
      <BlockStack gap="500">
        {props.settings.enabled ? (
          props.settings.criticalMissing || !props.settings.vapiReady ? (
            <Banner tone="warning" title="Finish call setup">
              <p>Automation is enabled, but the call provider configuration is incomplete. Open Settings before running live recovery calls.</p>
            </Banner>
          ) : (
            <Banner tone="success" title="Recovery automation is ready">
              <p>Your AI agent is ready to call eligible abandoned checkouts using the timing and offer rules in Settings.</p>
            </Banner>
          )
        ) : (
          <Banner tone="info" title="Recovery automation is paused">
            <p>Enable automation in Settings when you are ready to start calling eligible abandoned checkouts.</p>
          </Banner>
        )}

        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Performance overview
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {props.range.label} · verified Shopify recovery data
              </Text>
            </BlockStack>

            <InlineStack gap="300" blockAlign="center">
              {rangeButtons}
              <Form method="post">
                <input type="hidden" name="intent" value="sync_now" />
                <Button submit>Sync now</Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="create_test_call" />
                <Button submit variant="primary" disabled={!props.canCreateTestCall}>
                  Test call
                </Button>
              </Form>
            </InlineStack>
          </InlineStack>
        </Card>

        {props.hero.show ? (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="500">
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="success">Verified revenue</Badge>
                  <Badge tone="info">{props.range.label}</Badge>
                </InlineStack>
                <Text as="p" variant="heading2xl">
                  {props.hero.recoveredRevenueText}
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {props.hero.recoveredCount} recovered checkouts · {props.hero.winRate}% win rate
                </Text>
              </BlockStack>
              <Button url={props.hero.href}>View recoveries</Button>
            </InlineStack>
          </Card>
        ) : null}

        <BlockStack gap="300">
          <SectionHeader title="Key metrics" subtitle="The numbers that matter most for recovery performance." />
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            {props.metrics.map((metric) => (
              <MetricCard key={metric.key} {...metric} />
            ))}
          </InlineGrid>
        </BlockStack>

        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <SectionHeader title="Recovery pipeline" subtitle="Where eligible abandoned checkouts are right now." />
                <BlockStack gap="200">
                  {props.pipelineRows.map((row, index) => (
                    <React.Fragment key={row.key}>
                      <InlineStack align="space-between" blockAlign="center" gap="300">
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="medium">
                            {row.label}
                          </Text>
                          <Button url={row.href} variant="plain" size="slim">
                            View checkouts
                          </Button>
                        </BlockStack>
                        <Badge tone={badgeTone(row.tone)}>{String(row.count)}</Badge>
                      </InlineStack>
                      {index < props.pipelineRows.length - 1 ? <Divider /> : null}
                    </React.Fragment>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card padding="0">
              <Box padding="400">
                <SectionHeader title="Live activity" subtitle="Latest AI call events and outcomes." />
              </Box>
              <IndexTable
                resourceName={{ singular: "activity", plural: "activities" }}
                itemCount={props.liveRows.length}
                headings={[{ title: "Event" }, { title: "Status" }, { title: "When" }, { title: "Links" }]}
                selectable={false}
                emptyState={
                  <Box padding="500">
                    <Text as="p" tone="subdued" alignment="center">
                      No recent activity yet.
                    </Text>
                  </Box>
                }
              >
                {liveRows}
              </IndexTable>
            </Card>
          </Layout.Section>
        </Layout>

        <Card padding="0">
          <Box padding="400">
            <SectionHeader title="Today’s priorities" subtitle="Recovery opportunities that deserve attention first." />
          </Box>
          <IndexTable
            resourceName={{ singular: "priority", plural: "priorities" }}
            itemCount={props.priorities.length}
            headings={[{ title: "Priority" }, { title: "Count" }, { title: "Next best action" }, { title: "" }]}
            selectable={false}
          >
            {priorityRows}
          </IndexTable>
        </Card>

        <Card padding="0">
          <Box padding="400">
            <SectionHeader title="Recent recoveries" subtitle="Verified Shopify orders attributed to abandoned checkout recovery." />
          </Box>
          <IndexTable
            resourceName={{ singular: "recovery", plural: "recoveries" }}
            itemCount={props.recentRecoveries.length}
            headings={[{ title: "Customer" }, { title: "Recovered" }, { title: "When" }, { title: "Order" }]}
            selectable={false}
            emptyState={
              <Box padding="500">
                <Text as="p" tone="subdued" alignment="center">
                  No verified recoveries yet.
                </Text>
              </Box>
            }
          >
            {recoveryRows}
          </IndexTable>
        </Card>

        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <SectionHeader title="Top blockers" subtitle="Most common blockers from AI call summaries in the last 7 days." />
                {props.blockers.total === 0 ? (
                  <Text as="p" tone="subdued">
                    No call summaries in the last 7 days.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    {props.blockers.rows.map((row, index) => (
                      <React.Fragment key={row.key}>
                        <InlineStack align="space-between" blockAlign="center" gap="300">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd">
                              {row.label}
                            </Text>
                            <Badge tone={badgeTone(row.tone)}>{String(row.count)}</Badge>
                          </InlineStack>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {row.pct == null ? "—" : `${row.pct}%`} of {props.blockers.total}
                          </Text>
                        </InlineStack>
                        {index < props.blockers.rows.length - 1 ? <Divider /> : null}
                      </React.Fragment>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <SectionHeader title="Automation setup" subtitle="A quick view of the settings that control recovery calls." />
                <BlockStack gap="300">
                  {settingsRows.map((row, index) => (
                    <React.Fragment key={row.label}>
                      <InlineStack align="space-between" blockAlign="center" gap="300">
                        <Text as="span" variant="bodyMd">
                          {row.label}
                        </Text>
                        <Badge tone={badgeTone(row.tone)}>{row.value}</Badge>
                      </InlineStack>
                      {index < settingsRows.length - 1 ? <Divider /> : null}
                    </React.Fragment>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

export default DashboardView;
