// app/components/dashboard/DashboardView.tsx
import * as React from "react";
import { Form } from "react-router";

type BadgeTone = "success" | "info" | "warning" | "critical" | "new";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-page": any;
      "s-section": any;
      "s-box": any;
      "s-text": any;
      "s-heading": any;
      "s-badge": any;
      "s-banner": any;
      "s-divider": any;
      "s-grid": any;
      "s-stack": any;
      "s-query-container": any;
      "s-table": any;
      "s-table-header-row": any;
      "s-table-header": any;
      "s-table-body": any;
      "s-table-row": any;
      "s-table-cell": any;
      "s-button": any;
      "s-button-group": any;
      "s-clickable": any;
      "s-link": any;
      "s-chip": any;
    }
  }
}

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

function toneBadge(t: BadgeTone) {
  return t;
}

function metricTile(props: {
  label: string;
  valueText: string;
  tone: BadgeTone;
  deltaText?: string | null;
  href: string;
}) {
  return (
    <s-clickable href={props.href} accessibilityRole="link">
      <s-box border="base" borderRadius="base" padding="base" background="base">
        <s-stack gap="tight">
          <s-text tone="subdued">{props.label}</s-text>
          <s-heading size="small">{props.valueText}</s-heading>
          <s-stack direction="inline" gap="tight">
            <s-badge tone={toneBadge(props.tone)}>{props.tone.toUpperCase()}</s-badge>
            {props.deltaText ? <s-badge tone="new">{props.deltaText}</s-badge> : null}
          </s-stack>
        </s-stack>
      </s-box>
    </s-clickable>
  );
}

export function DashboardView(props: DashboardViewProps) {
  return (
    <s-page heading="Dashboard">
      <s-stack slot="secondary-actions" direction="inline" gap="tight">
        <s-link href={props.nav.checkoutsHref}>Open checkouts</s-link>
        <s-link href={props.nav.callsHref}>Open calls</s-link>
      </s-stack>

      <s-stack direction="block" gap="base">
        {/* Time range + actions */}
        <s-section>
          <s-box border="base" borderRadius="base" padding="base" background="base">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" align="space-between" gap="base">
                <s-stack direction="block" gap="tight">
                  <s-text tone="subdued">Time range</s-text>
                  <s-button-group>
                    <s-button href={props.range.links.all} variant={props.range.key === "all" ? "primary" : "secondary"}>
                      All-time
                    </s-button>
                    <s-button href={props.range.links.d7} variant={props.range.key === "7d" ? "primary" : "secondary"}>
                      7d
                    </s-button>
                    <s-button href={props.range.links.h24} variant={props.range.key === "24h" ? "primary" : "secondary"}>
                      24h
                    </s-button>
                  </s-button-group>
                </s-stack>

                <s-button-group>
                  <Form method="post">
                    <input type="hidden" name="intent" value="sync_now" />
                    <s-button type="submit" variant="secondary">
                      Sync now
                    </s-button>
                  </Form>

                  <Form method="post">
                    <input type="hidden" name="intent" value="create_test_call" />
                    <s-button type="submit" variant="primary" disabled={!props.canCreateTestCall}>
                      Create test call
                    </s-button>
                  </Form>
                </s-button-group>
              </s-stack>

              {props.settings.criticalMissing ? (
                <s-banner tone="critical" heading="Automation is enabled but Vapi is not ready">
                  <s-text>
                    Add Vapi Assistant ID and Phone Number ID in Settings to start calls.
                  </s-text>
                </s-banner>
              ) : null}
            </s-stack>
          </s-box>
        </s-section>

        {/* HERO recovered callout */}
        {props.hero.show ? (
          <s-section>
            <s-box border="base" borderRadius="base" padding="base" background="subdued">
              <s-stack direction="block" gap="tight">
                <s-heading>You recovered {props.hero.recoveredRevenueText}</s-heading>
                <s-text tone="subdued">
                  from {props.hero.recoveredCount} recovered checkouts • Win rate {props.hero.winRate}%
                </s-text>
                <s-stack direction="inline" gap="tight">
                  <s-badge tone="success">RECOVERED</s-badge>
                  <s-badge tone="info">{props.range.label}</s-badge>
                </s-stack>
                <s-button href={props.hero.href} variant="primary">
                  View recovered checkouts
                </s-button>
              </s-stack>
            </s-box>
          </s-section>
        ) : null}

        {/* Metrics tiles row (merchant-value first) */}
        <s-section>
          <s-stack direction="block" gap="tight">
            <s-heading size="small">Key metrics</s-heading>
            <s-text tone="subdued">Click a metric to drill into the relevant list view.</s-text>

            <s-grid
              gap="base"
              gridTemplateColumns="@container (inline-size < 860px) 1fr 1fr, 1fr 1fr 1fr 1fr"
            >
              {props.metrics.map((m) => (
                <React.Fragment key={m.key}>
                  {metricTile(m)}
                </React.Fragment>
              ))}
            </s-grid>

            <s-stack direction="inline" gap="tight">
              <s-chip>Eligible = contactable + meets min order value</s-chip>
              <s-chip>Follow-ups = needs_followup outcomes</s-chip>
              <s-chip>Discounts = suggested or percent &gt; 0</s-chip>
            </s-stack>
          </s-stack>
        </s-section>

        {/* Two-column: pipeline + live */}
        <s-query-container>
          <s-grid gap="base" gridTemplateColumns="@container (inline-size < 960px) 1fr, 1fr 1fr">
            {/* Recovery pipeline */}
            <s-section heading="Recovery pipeline">
              <s-box border="base" borderRadius="base" padding="base" background="base">
                <s-stack direction="block" gap="tight">
                  {props.pipelineRows.map((p) => (
                    <s-clickable key={p.key} href={p.href} accessibilityRole="link">
                      <s-box border="base" borderRadius="base" padding="base" background="base">
                        <s-stack direction="inline" align="space-between" gap="base">
                          <s-text>{p.label}</s-text>
                          <s-stack direction="inline" gap="tight">
                            <s-badge tone={toneBadge(p.tone)}>{String(p.count)}</s-badge>
                            <s-badge tone="new">View</s-badge>
                          </s-stack>
                        </s-stack>
                      </s-box>
                    </s-clickable>
                  ))}
                </s-stack>
              </s-box>
            </s-section>

            {/* Live activity */}
            <s-section heading="Live activity">
              <s-box border="base" borderRadius="base" background="base">
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Event</s-table-header>
                    <s-table-header>Status</s-table-header>
                    <s-table-header>When</s-table-header>
                    <s-table-header>Links</s-table-header>
                  </s-table-header-row>

                  <s-table-body>
                    {props.liveRows.length === 0 ? (
                      <s-table-row>
                        <s-table-cell colSpan={4}>
                          <s-box padding="base">
                            <s-text tone="subdued">No recent activity.</s-text>
                          </s-box>
                        </s-table-cell>
                      </s-table-row>
                    ) : (
                      props.liveRows.map((r) => (
                        <s-table-row key={r.key}>
                          <s-table-cell>{r.event}</s-table-cell>
                          <s-table-cell>
                            <s-badge tone={toneBadge(r.tone)}>{r.status}</s-badge>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text tone="subdued">{r.whenText}</s-text>
                          </s-table-cell>
                          <s-table-cell>
                            <s-stack direction="inline" gap="tight">
                              {r.recordingUrl ? <s-link href={r.recordingUrl}>Recording</s-link> : <s-text tone="subdued">—</s-text>}
                              {r.logUrl ? <s-link href={r.logUrl}>Logs</s-link> : null}
                            </s-stack>
                          </s-table-cell>
                        </s-table-row>
                      ))
                    )}
                  </s-table-body>
                </s-table>
              </s-box>
            </s-section>
          </s-grid>
        </s-query-container>

        {/* Today’s priorities (full width) */}
        <s-section heading="Today’s priorities">
          <s-box border="base" borderRadius="base" background="base">
            <s-table>
              <s-table-header-row>
                <s-table-header>Priority</s-table-header>
                <s-table-header>Count</s-table-header>
                <s-table-header>Next best action</s-table-header>
                <s-table-header>View</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {props.priorities.map((p) => (
                  <s-table-row key={p.key}>
                    <s-table-cell>
                      <s-stack direction="block" gap="tight">
                        <s-text>{p.label}</s-text>
                        {p.rawCountText ? <s-text tone="subdued">{p.rawCountText}</s-text> : null}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={toneBadge(p.tone)}>{String(p.count)}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text tone={p.nextBestAction ? "base" : "subdued"}>
                        {p.nextBestAction || "—"}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-link href={p.href}>View</s-link>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-box>
        </s-section>

        {/* Recent recoveries */}
        <s-section heading="Recent recoveries">
          <s-box border="base" borderRadius="base" background="base">
            <s-table>
              <s-table-header-row>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Recovered</s-table-header>
                <s-table-header>When</s-table-header>
                <s-table-header>Order</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {props.recentRecoveries.length === 0 ? (
                  <s-table-row>
                    <s-table-cell colSpan={4}>
                      <s-box padding="base">
                        <s-text tone="subdued">No recoveries yet.</s-text>
                      </s-box>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  props.recentRecoveries.map((r) => (
                    <s-table-row key={r.checkoutId}>
                      <s-table-cell>
                        <s-stack direction="block" gap="tight">
                          <s-link href={r.href}>{r.customerName || `Checkout ${r.checkoutId}`}</s-link>
                          <s-text tone="subdued">#{r.checkoutId}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone="success">{r.amountText}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text tone="subdued">{r.whenText}</s-text>
                      </s-table-cell>
                      <s-table-cell>{r.recoveredOrderId}</s-table-cell>
                    </s-table-row>
                  ))
                )}
              </s-table-body>
            </s-table>
          </s-box>
        </s-section>

        {/* Top blockers (7d) */}
        <s-section heading="Top blockers (7d)">
          <s-box border="base" borderRadius="base" padding="base" background="base">
            <s-stack direction="block" gap="tight">
              <s-text tone="subdued">Based on vapi_call_summaries in the last 7 days.</s-text>
              {props.blockers.total === 0 ? (
                <s-text tone="subdued">No calls in the last 7 days.</s-text>
              ) : (
                props.blockers.rows.map((b) => (
                  <s-box key={b.key} border="base" borderRadius="base" padding="base" background="subdued">
                    <s-stack direction="inline" align="space-between" gap="base">
                      <s-stack direction="inline" gap="tight">
                        <s-text>{b.label}</s-text>
                        <s-badge tone={toneBadge(b.tone)}>{String(b.count)}</s-badge>
                      </s-stack>
                      <s-stack direction="inline" gap="tight">
                        <s-badge tone="new">{b.pct == null ? "—" : `${b.pct}%`}</s-badge>
                        <s-text tone="subdued">of {props.blockers.total}</s-text>
                      </s-stack>
                    </s-stack>
                  </s-box>
                ))
              )}
            </s-stack>
          </s-box>
        </s-section>

        {/* System status / Settings snapshot */}
        <s-section heading="System status / Settings snapshot">
          <s-box border="base" borderRadius="base" padding="base" background="base">
            <s-stack direction="block" gap="base">
              {props.settings.enabled && !props.settings.vapiReady ? (
                <s-banner tone="critical" heading="Calls cannot start yet">
                  <s-text>Automation is enabled but Vapi IDs are missing.</s-text>
                </s-banner>
              ) : null}

              <s-table>
                <s-table-header-row>
                  <s-table-header>Setting</s-table-header>
                  <s-table-header>Value</s-table-header>
                </s-table-header-row>

                <s-table-body>
                  {props.settings.rows.map((r) => (
                    <s-table-row key={r.label}>
                      <s-table-cell>{r.label}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="tight">
                          <s-badge tone={toneBadge(r.tone)}>{r.value}</s-badge>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-stack>
          </s-box>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export default DashboardView;