// app/components/dashboard/DashboardView.tsx
import * as React from "react";
import { Form } from "react-router";

type Tone = "green" | "blue" | "amber" | "red" | "neutral";

type ReasonRow = { label: string; pct: number };
type LiveRow = { label: string; whenText: string; tone: Exclude<Tone, "neutral"> };

export type DashboardViewProps = {
  title: string;
  shopLabel?: string;

  status?: {
    providerText?: string; // "Vapi ready" / "Sim mode"
    automationText?: string; // "Automation ON/OFF"
    lastSyncText?: string; // "Just now" / "2m ago"
  };

  nav?: {
    checkoutsHref: string;
    callsHref: string;
  };

  kpis: Array<{
    label: string;
    value: string;
    sub?: string;
    tone: Tone;
    barPct?: number | null;
  }>;

  pipeline: Array<{ label: string; value: number; tone: Exclude<Tone, "neutral"> }>;
  live: LiveRow[];
  reasons: ReasonRow[];

  priorities?: Array<{ label: string; count: number; tone: Tone; href?: string }>;

  recentRecoveries?: Array<{
    orderOrCheckout: string;
    amount: string;
    whenText: string;
    outcome?: string;
  }>;

  recommendations?: string[];

  canCreateTestCall: boolean;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-page": any;
      "s-section": any;
      "s-box": any;
      "s-text": any;
      "s-badge": any;
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
    }
  }
}

function clampPct(n: number) {
  return Math.max(0, Math.min(100, n));
}

function badgeTone(t: Tone): "success" | "info" | "warning" | "critical" | "new" {
  if (t === "green") return "success";
  if (t === "blue") return "info";
  if (t === "amber") return "warning";
  if (t === "red") return "critical";
  return "new";
}

function barColor(t: Tone) {
  if (t === "green") return "rgba(0,128,96,0.95)";
  if (t === "blue") return "rgba(0,91,211,0.95)";
  if (t === "amber") return "rgba(178,132,0,0.95)";
  if (t === "red") return "rgba(216,44,13,0.95)";
  return "rgba(128,133,144,0.95)";
}

function ToneDot({ tone }: { tone: Exclude<Tone, "neutral"> }) {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: barColor(tone),
        display: "inline-block",
        boxShadow: "0 0 0 2px rgba(0,0,0,0.06)",
        flex: "0 0 auto",
      }}
      aria-hidden="true"
    />
  );
}

function KpiCard({ k }: { k: DashboardViewProps["kpis"][number] }) {
  const pct = typeof k.barPct === "number" ? clampPct(k.barPct) : null;

  return (
    <s-box border="base" borderRadius="base" background="base" padding="base">
      <s-stack direction="block" gap="tight">
        <s-stack direction="inline" align="space-between" gap="base">
          <s-text variant="bodySm" tone="subdued">
            {k.label}
          </s-text>
          <s-badge tone={badgeTone(k.tone)}>{k.tone === "neutral" ? "Info" : k.tone.toUpperCase()}</s-badge>
        </s-stack>

        <s-stack direction="inline" gap="base" align="start" style={{ alignItems: "baseline" }}>
          <s-text variant="headingLg">{k.value}</s-text>
          {k.sub ? (
            <s-text variant="bodySm" tone="subdued">
              {k.sub}
            </s-text>
          ) : null}
        </s-stack>

        <div style={{ height: 6, borderRadius: 999, background: "rgba(0,0,0,0.08)", overflow: "hidden" }}>
          <div
            style={{
              width: `${pct ?? 40}%`,
              height: "100%",
              background: barColor(k.tone),
            }}
          />
        </div>
      </s-stack>
    </s-box>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <s-box padding="base">
      <s-text tone="subdued">{text}</s-text>
    </s-box>
  );
}

export function DashboardView(props: DashboardViewProps) {
  const summary = (() => {
    const by = (needle: string) => props.kpis.find((x) => x.label.toLowerCase().includes(needle));
    const recoveredRev = by("recovered revenue") ?? by("recovered");
    const atRisk = by("at-risk") ?? by("potential") ?? by("at risk");
    const win = by("win rate");

    const parts: string[] = [];
    if (recoveredRev) parts.push(`${recoveredRev.label}: ${recoveredRev.value}`);
    if (atRisk) parts.push(`${atRisk.label}: ${atRisk.value}`);
    if (win) parts.push(`${win.label}: ${win.value}`);
    return parts.length ? parts.join(" • ") : "Snapshot will populate once calls complete and outcomes are recorded.";
  })();

  const statusBadges = (
    <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
      {props.status?.providerText ? <s-badge tone="info">{props.status.providerText}</s-badge> : null}
      {props.status?.automationText ? (
        <s-badge tone={props.status.automationText.toUpperCase().includes("ON") ? "success" : "warning"}>
          {props.status.automationText}
        </s-badge>
      ) : null}
      {props.status?.lastSyncText ? <s-badge tone="new">{props.status.lastSyncText}</s-badge> : null}
    </s-stack>
  );

  const navButtons = (
    <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
      {props.nav?.checkoutsHref ? (
        <s-button href={props.nav.checkoutsHref} variant="secondary">
          Open checkouts
        </s-button>
      ) : null}
      {props.nav?.callsHref ? (
        <s-button href={props.nav.callsHref} variant="secondary">
          Open calls
        </s-button>
      ) : null}

      <s-button-group>
        <Form method="post">
          <input type="hidden" name="intent" value="sync_now" />
          <s-button type="submit" variant="secondary" slot="secondary-actions">
            Sync now
          </s-button>
        </Form>

        <Form method="post">
          <input type="hidden" name="intent" value="create_test_call" />
          <s-button type="submit" variant="primary" slot="primary-action" disabled={!props.canCreateTestCall}>
            Create test call
          </s-button>
        </Form>
      </s-button-group>
    </s-stack>
  );

  return (
    <s-page>
      <s-stack direction="block" gap="base">
        {/* Header */}
        <s-section>
          <s-stack direction="block" gap="tight">
            <s-text variant="headingLg">{props.title}</s-text>
            {props.shopLabel ? <s-text tone="subdued">{props.shopLabel}</s-text> : null}

            <s-divider />

            <s-stack direction="inline" align="space-between" gap="base" style={{ flexWrap: "wrap" }}>
              {statusBadges}
              {navButtons}
            </s-stack>
          </s-stack>
        </s-section>

        {/* KPIs */}
        <s-query-container>
          <s-grid
            gap="base"
            gridTemplateColumns="@container (inline-size < 860px) repeat(2, minmax(0, 1fr)), repeat(6, minmax(0, 1fr))"
          >
            {props.kpis.map((k) => (
              <KpiCard key={k.label} k={k} />
            ))}
          </s-grid>
        </s-query-container>

        {/* Value strip */}
        <s-section>
          <s-text>{summary}</s-text>
        </s-section>

        {/* Main grid */}
        <s-query-container>
          <s-grid gap="base" gridTemplateColumns="@container (inline-size < 960px) 1fr, 2fr 1fr">
            {/* Left */}
            <s-stack direction="block" gap="base">
              {/* Pipeline */}
              <s-section>
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" align="space-between" gap="base">
                    <s-text variant="headingMd">Recovery pipeline</s-text>
                    <s-badge tone="new">Operational</s-badge>
                  </s-stack>
                  <s-divider />

                  {props.pipeline.length === 0 ? (
                    <Empty text="No pipeline data yet." />
                  ) : (
                    <s-query-container>
                      <s-grid
                        gap="base"
                        gridTemplateColumns="@container (inline-size < 860px) repeat(2, minmax(0, 1fr)), repeat(6, minmax(0, 1fr))"
                      >
                        {props.pipeline.map((p) => (
                          <s-box key={p.label} border="base" borderRadius="base" padding="base" background="base">
                            <s-stack direction="block" gap="tight">
                              <s-stack direction="inline" align="space-between" gap="base">
                                <s-text variant="bodySm" tone="subdued">
                                  {p.label}
                                </s-text>
                                <s-badge tone={badgeTone(p.tone)}>{p.value}</s-badge>
                              </s-stack>
                              <s-text variant="headingMd">{p.value}</s-text>
                            </s-stack>
                          </s-box>
                        ))}
                      </s-grid>
                    </s-query-container>
                  )}
                </s-stack>
              </s-section>

              {/* Priorities + Proof */}
              <s-query-container>
                <s-grid gap="base" gridTemplateColumns="@container (inline-size < 960px) 1fr, 1fr 1fr">
                  {/* Priorities */}
                  <s-section>
                    <s-stack direction="block" gap="tight">
                      <s-stack direction="inline" align="space-between" gap="base">
                        <s-text variant="headingMd">Today’s priorities</s-text>
                        <s-badge tone="new">{props.priorities?.length ? "Actionable" : "Empty"}</s-badge>
                      </s-stack>
                      <s-divider />

                      {!props.priorities || props.priorities.length === 0 ? (
                        <Empty text="No priorities yet." />
                      ) : (
                        <s-stack direction="block" gap="tight">
                          {props.priorities.slice(0, 6).map((p) => (
                            <s-stack key={p.label} direction="inline" align="space-between" gap="base">
                              <s-stack direction="inline" gap="tight" style={{ minWidth: 0, alignItems: "center" }}>
                                <ToneDot tone={(p.tone === "neutral" ? "blue" : p.tone) as any} />
                                <s-text style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {p.label}
                                </s-text>
                              </s-stack>
                              <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
                                <s-badge tone={badgeTone(p.tone)}>{p.count}</s-badge>
                                {p.href ? (
                                  <s-button href={p.href} variant="tertiary">
                                    View
                                  </s-button>
                                ) : null}
                              </s-stack>
                            </s-stack>
                          ))}
                        </s-stack>
                      )}
                    </s-stack>
                  </s-section>

                  {/* Recent recoveries */}
                  <s-section>
                    <s-stack direction="block" gap="tight">
                      <s-stack direction="inline" align="space-between" gap="base">
                        <s-text variant="headingMd">Recent recoveries</s-text>
                        <s-badge tone="success">{props.recentRecoveries?.length ? "Proof" : "None"}</s-badge>
                      </s-stack>
                      <s-divider />

                      {!props.recentRecoveries || props.recentRecoveries.length === 0 ? (
                        <Empty text="No recovered orders yet." />
                      ) : (
                        <s-section padding="none">
                          <s-table>
                            <s-table-header-row>
                              <s-table-header listSlot="primary">Order/Checkout</s-table-header>
                              <s-table-header listSlot="inline" format="currency">
                                Amount
                              </s-table-header>
                              <s-table-header listSlot="secondary">When</s-table-header>
                              <s-table-header listSlot="secondary">Outcome</s-table-header>
                            </s-table-header-row>
                            <s-table-body>
                              {props.recentRecoveries.slice(0, 5).map((r, idx) => (
                                <s-table-row key={`${r.orderOrCheckout}-${idx}`}>
                                  <s-table-cell>{r.orderOrCheckout}</s-table-cell>
                                  <s-table-cell>{r.amount}</s-table-cell>
                                  <s-table-cell>{r.whenText}</s-table-cell>
                                  <s-table-cell>{r.outcome ?? "-"}</s-table-cell>
                                </s-table-row>
                              ))}
                            </s-table-body>
                          </s-table>
                        </s-section>
                      )}
                    </s-stack>
                  </s-section>
                </s-grid>
              </s-query-container>

              {/* Blockers + Recommendations */}
              <s-query-container>
                <s-grid gap="base" gridTemplateColumns="@container (inline-size < 960px) 1fr, 1fr 1fr">
                  <s-section>
                    <s-stack direction="block" gap="tight">
                      <s-stack direction="inline" align="space-between" gap="base">
                        <s-text variant="headingMd">Top blockers</s-text>
                        <s-badge tone="info">7d</s-badge>
                      </s-stack>
                      <s-divider />

                      {props.reasons.length === 0 ? (
                        <Empty text="No blocker data yet." />
                      ) : (
                        <s-stack direction="block" gap="tight">
                          {props.reasons.slice(0, 8).map((r) => (
                            <s-stack key={r.label} direction="inline" align="space-between" gap="base">
                              <s-text style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {r.label}
                              </s-text>
                              <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
                                <div
                                  style={{
                                    width: 140,
                                    height: 6,
                                    borderRadius: 999,
                                    background: "rgba(0,0,0,0.08)",
                                    overflow: "hidden",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: `${clampPct(r.pct)}%`,
                                      height: "100%",
                                      background: "rgba(178,132,0,0.95)",
                                    }}
                                  />
                                </div>
                                <s-text tone="subdued">{clampPct(r.pct)}%</s-text>
                              </s-stack>
                            </s-stack>
                          ))}
                        </s-stack>
                      )}
                    </s-stack>
                  </s-section>

                  <s-section>
                    <s-stack direction="block" gap="tight">
                      <s-stack direction="inline" align="space-between" gap="base">
                        <s-text variant="headingMd">What to change next</s-text>
                        <s-badge tone="info">Settings</s-badge>
                      </s-stack>
                      <s-divider />

                      {!props.recommendations || props.recommendations.length === 0 ? (
                        <Empty text="No recommendations yet." />
                      ) : (
                        <s-stack direction="block" gap="tight">
                          {props.recommendations.slice(0, 6).map((t, i) => (
                            <s-text key={`${t}-${i}`}>• {t}</s-text>
                          ))}
                        </s-stack>
                      )}
                    </s-stack>
                  </s-section>
                </s-grid>
              </s-query-container>
            </s-stack>

            {/* Right: Live */}
            <s-section>
              <s-stack direction="block" gap="tight">
                <s-stack direction="inline" align="space-between" gap="base">
                  <s-text variant="headingMd">Live activity</s-text>
                  <s-badge tone={props.live.length ? "new" : "info"}>{props.live.length ? "Live" : "Idle"}</s-badge>
                </s-stack>
                <s-divider />

                {props.live.length === 0 ? (
                  <Empty text="No recent activity." />
                ) : (
                  <s-stack direction="block" gap="tight">
                    {props.live.slice(0, 10).map((r, i) => (
                      <s-stack key={`${r.label}-${i}`} direction="inline" align="space-between" gap="base">
                        <s-stack direction="inline" gap="tight" style={{ minWidth: 0, alignItems: "center" }}>
                          <ToneDot tone={r.tone} />
                          <s-text style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {r.label}
                          </s-text>
                        </s-stack>
                        <s-text tone="subdued">{r.whenText}</s-text>
                      </s-stack>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-section>
          </s-grid>
        </s-query-container>
      </s-stack>
    </s-page>
  );
}
