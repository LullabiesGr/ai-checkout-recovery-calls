// app/components/dashboard/DashboardView.tsx
import * as React from "react";
import { Form } from "react-router";

type Tone = "green" | "blue" | "amber" | "red" | "neutral";

type ReasonRow = { label: string; pct: number };
type LiveRow = { label: string; whenText: string; tone: Exclude<Tone, "neutral"> };

type KpiKey =
  | "recovered_revenue"
  | "at_risk_revenue"
  | "win_rate"
  | "answer_rate"
  | "queued_calls"
  | "calling_now"
  | "completed_calls"
  | "avg_call_duration"
  | "avg_attempts"
  | "opt_outs"
  | string;

export type DashboardViewProps = {
  title: string;
  shopLabel?: string;

  status?: {
    providerText?: string;
    automationText?: string;
    lastSyncText?: string;
  };

  nav?: {
    checkoutsHref: string;
    callsHref: string;
  };

  kpis: Array<{
    key?: KpiKey;
    label: string;
    value: string;
    sub?: string;
    tone: Tone;
    barPct?: number | null;

    series?: number[];
    deltaText?: string;
    deltaTone?: Tone;
  }>;

  pipeline: Array<{ label: string; value: number; tone: Exclude<Tone, "neutral"> }>;
  live: LiveRow[];
  reasons: ReasonRow[];

  // UPDATED: richer priorities rows (table-friendly)
  priorities?: Array<{
    label: string;
    count: number;
    tone: Tone;
    href?: string;

    // Optional enrichment from outcomes table (Supabase vapi_call_summaries)
    action?: string; // next_best_action / best_next_action
    details?: string; // e.g. "Buy 70% • NO_ANSWER"
    badge?: string; // e.g. "AI" / "Calls" / "Revenue"
  }>;

  recentRecoveries?: Array<{
    orderOrCheckout: string;
    amount: string;
    whenText: string;
    outcome?: string;
  }>;

  recommendations?: string[];

  settingsSnapshot?: Array<{ label: string; value: string; tone?: Tone; href?: string }>;

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

function subtleBg(t: Tone) {
  if (t === "green") return "rgba(0,128,96,0.06)";
  if (t === "blue") return "rgba(0,91,211,0.06)";
  if (t === "amber") return "rgba(178,132,0,0.07)";
  if (t === "red") return "rgba(216,44,13,0.06)";
  return "rgba(128,133,144,0.06)";
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

function Sparkline({
  points,
  tone,
  width = 140,
  height = 28,
}: {
  points?: number[];
  tone: Tone;
  width?: number;
  height?: number;
}) {
  const data = Array.isArray(points) ? points.filter((n) => Number.isFinite(n)) : [];
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;

  const stepX = width / (data.length - 1);
  const coords = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * height;
    return { x, y };
  });

  const d = coords.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const stroke = barColor(tone);
  const fill = subtleBg(tone);

  const areaD =
    `M 0 ${height.toFixed(2)} ` +
    coords.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ") +
    ` L ${width.toFixed(2)} ${height.toFixed(2)} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="trend">
      <path d={areaD} fill={fill} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <s-box padding="base">
      <s-text tone="subdued">{text}</s-text>
    </s-box>
  );
}

function SectionHeader({
  title,
  badgeText,
  badgeTone: bt = "new",
  right,
}: {
  title: string;
  badgeText?: string;
  badgeTone?: "success" | "info" | "warning" | "critical" | "new";
  right?: React.ReactNode;
}) {
  return (
    <s-stack direction="inline" align="space-between" gap="base" style={{ flexWrap: "wrap", alignItems: "center" }}>
      <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
        <s-text variant="headingMd">{title}</s-text>
        {badgeText ? <s-badge tone={bt}>{badgeText}</s-badge> : null}
      </s-stack>
      {right ?? null}
    </s-stack>
  );
}

function kpiId(k: DashboardViewProps["kpis"][number]) {
  return String(k.key ?? k.label).toLowerCase().trim();
}

function pickKpi(
  kpis: DashboardViewProps["kpis"],
  by: { keyIncludes?: string[]; labelIncludes?: string[] }
) {
  const keyIncludes = by.keyIncludes?.map((s) => s.toLowerCase()) ?? [];
  const labelIncludes = by.labelIncludes?.map((s) => s.toLowerCase()) ?? [];

  const hitKey = kpis.find((k) => {
    const kk = (k.key ?? "").toString().toLowerCase();
    return keyIncludes.some((x) => kk.includes(x));
  });
  if (hitKey) return hitKey;

  const hitLabel = kpis.find((k) => {
    const ll = k.label.toLowerCase();
    return labelIncludes.some((x) => ll.includes(x));
  });
  return hitLabel ?? null;
}

function severityToneFromPct(pct: number): Exclude<Tone, "neutral"> {
  if (pct >= 60) return "red";
  if (pct >= 35) return "amber";
  return "blue";
}

function PrimaryKpiCard({ k }: { k: DashboardViewProps["kpis"][number] }) {
  const pct = typeof k.barPct === "number" ? clampPct(k.barPct) : null;
  const deltaTone = k.deltaTone ?? k.tone;

  return (
    <s-box border="base" borderRadius="base" background="base" padding="base" style={{ background: subtleBg(k.tone) }}>
      <s-stack direction="block" gap="tight">
        <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center" }}>
          <s-text variant="bodySm" tone="subdued">
            {k.label}
          </s-text>
          <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
            {k.deltaText ? <s-badge tone={badgeTone(deltaTone)}>{k.deltaText}</s-badge> : null}
            <s-badge tone={badgeTone(k.tone)}>{k.tone === "neutral" ? "Info" : k.tone.toUpperCase()}</s-badge>
          </s-stack>
        </s-stack>

        <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "baseline" }}>
          <s-stack direction="block" gap="tight">
            <s-text variant="headingLg">{k.value}</s-text>
            {k.sub ? (
              <s-text variant="bodySm" tone="subdued">
                {k.sub}
              </s-text>
            ) : null}
          </s-stack>
          <Sparkline points={k.series} tone={k.tone} width={170} height={34} />
        </s-stack>

        {pct !== null ? (
          <div style={{ height: 4, borderRadius: 999, background: "rgba(0,0,0,0.08)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: barColor(k.tone) }} />
          </div>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function CompactKpiCard({ k }: { k: DashboardViewProps["kpis"][number] }) {
  const pct = typeof k.barPct === "number" ? clampPct(k.barPct) : null;
  const deltaTone = k.deltaTone ?? k.tone;

  return (
    <s-box border="base" borderRadius="base" background="base" padding="base">
      <s-stack direction="block" gap="tight">
        <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center" }}>
          <s-text variant="bodySm" tone="subdued">
            {k.label}
          </s-text>
          <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
            {k.deltaText ? <s-badge tone={badgeTone(deltaTone)}>{k.deltaText}</s-badge> : null}
            <s-badge tone={badgeTone(k.tone)}>{k.tone === "neutral" ? "Info" : k.tone.toUpperCase()}</s-badge>
          </s-stack>
        </s-stack>

        <s-stack direction="inline" gap="base" style={{ alignItems: "baseline" }}>
          <s-text variant="headingMd">{k.value}</s-text>
          {k.sub ? (
            <s-text variant="bodySm" tone="subdued">
              {k.sub}
            </s-text>
          ) : null}
        </s-stack>

        {pct !== null ? (
          <div style={{ height: 4, borderRadius: 999, background: "rgba(0,0,0,0.08)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: barColor(k.tone) }} />
          </div>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function parseLive(label: string): { event: string; status: string; attempt?: string } {
  const mAttempts = label.match(/\(attempts?\s+(\d+)\)/i);
  const attempt = mAttempts?.[1];

  const statusMatch = label.match(/\b(COMPLETED|CALLING|QUEUED|FAILED|NO ANSWER|VOICEMAIL|BUSY|CANCELED|CANCELLED)\b/i);
  const status = (statusMatch?.[1] ?? "").toUpperCase();

  const isCall = /^\s*Call\b/i.test(label);
  if (isCall) {
    return {
      event: `Call${attempt ? ` • Attempt ${attempt}` : ""}`,
      status: status || "CALL",
      attempt,
    };
  }

  return {
    event: label.replace(/\s*\(attempts?\s+\d+\)\s*/i, "").trim(),
    status: status || "EVENT",
    attempt,
  };
}

export function DashboardView(props: DashboardViewProps) {
  const recovered = pickKpi(props.kpis, {
    keyIncludes: ["recovered"],
    labelIncludes: ["recovered revenue", "recovered"],
  });
  const atRisk = pickKpi(props.kpis, {
    keyIncludes: ["at_risk", "risk", "potential"],
    labelIncludes: ["at-risk", "at risk", "potential"],
  });

  const primary: DashboardViewProps["kpis"] = [];
  if (recovered) primary.push(recovered);
  if (atRisk && (!recovered || kpiId(atRisk) !== kpiId(recovered))) primary.push(atRisk);

  if (primary.length < 2) {
    for (const k of props.kpis) {
      if (primary.length >= 2) break;
      if (primary.some((p) => kpiId(p) === kpiId(k))) continue;
      primary.push(k);
    }
  }

  const primaryIds = new Set(primary.map(kpiId));
  const secondary = props.kpis.filter((k) => !primaryIds.has(kpiId(k)));

  const summary = (() => {
    const by = (needle: string) => props.kpis.find((x) => x.label.toLowerCase().includes(needle));
    const recoveredRev = recovered ?? by("recovered revenue") ?? by("recovered");
    const atRiskRev = atRisk ?? by("at-risk") ?? by("potential") ?? by("at risk");
    const win = by("win rate");
    const answer = by("answer rate") ?? by("reach rate");

    const parts: string[] = [];
    if (recoveredRev) parts.push(`${recoveredRev.label}: ${recoveredRev.value}`);
    if (atRiskRev) parts.push(`${atRiskRev.label}: ${atRiskRev.value}`);
    if (win) parts.push(`${win.label}: ${win.value}`);
    if (answer) parts.push(`${answer.label}: ${answer.value}`);

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

  const cols2 = "@container (inline-size < 860px) 1fr, 1fr 1fr";
  const cols3 = "@container (inline-size < 860px) 1fr, 1fr 1fr 1fr";
  const cols4 = "@container (inline-size < 860px) 1fr 1fr, 1fr 1fr 1fr 1fr";

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

        {/* Primary value (2 cards) */}
        <s-query-container>
          <s-grid gap="base" gridTemplateColumns={cols2}>
            {primary.slice(0, 2).map((k) => (
              <PrimaryKpiCard key={kpiId(k)} k={k} />
            ))}
          </s-grid>
        </s-query-container>

        {/* Secondary KPIs */}
        {secondary.length ? (
          <s-query-container>
            <s-grid gap="base" gridTemplateColumns={cols4}>
              {secondary.slice(0, 8).map((k) => (
                <CompactKpiCard key={kpiId(k)} k={k} />
              ))}
            </s-grid>
          </s-query-container>
        ) : null}

        {/* Summary strip */}
        <s-section>
          <s-stack direction="inline" align="space-between" gap="base" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <s-text>{summary}</s-text>
            {props.settingsSnapshot && props.settingsSnapshot.length ? (
              <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                {props.settingsSnapshot.slice(0, 4).map((s) => (
                  <s-badge key={s.label} tone={badgeTone(s.tone ?? "neutral")}>
                    {s.label}: {s.value}
                  </s-badge>
                ))}
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>

        {/* Main grid */}
        <s-query-container>
          <s-grid gap="base" gridTemplateColumns="@container (inline-size < 960px) 1fr, 2fr 1fr">
            {/* Left */}
            <s-stack direction="block" gap="base">
              {/* Pipeline */}
              <s-section>
                <s-stack direction="block" gap="tight">
                  <SectionHeader title="Recovery pipeline" badgeText="Funnel" badgeTone="new" />
                  <s-divider />

                  {props.pipeline.length === 0 ? (
                    <Empty text="No pipeline data yet." />
                  ) : (
                    <s-query-container>
                      <s-grid gap="base" gridTemplateColumns={cols3}>
                        {props.pipeline.slice(0, 6).map((p) => (
                          <s-box
                            key={p.label}
                            border="base"
                            borderRadius="base"
                            background="base"
                            padding="base"
                            style={{ padding: 12 }}
                          >
                            <s-stack direction="inline" align="space-between" gap="base" style={{ alignItems: "center" }}>
                              <s-text variant="bodySm" tone="subdued">
                                {p.label}
                              </s-text>
                              <s-badge tone={badgeTone(p.tone)}>{p.value}</s-badge>
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
                  {/* Today’s priorities (TABLE) */}
                  <s-section>
                    <s-stack direction="block" gap="tight">
                      <SectionHeader
                        title="Today’s priorities"
                        badgeText={props.priorities?.length ? "Actionable" : "Empty"}
                        badgeTone={props.priorities?.length ? "new" : "info"}
                      />
                      <s-divider />

                      {!props.priorities || props.priorities.length === 0 ? (
                        <Empty text="No priorities yet." />
                      ) : (
                        <s-section padding="none">
                          <s-table>
                            <s-table-header-row>
                              <s-table-header listSlot="primary">Priority</s-table-header>
                              <s-table-header listSlot="inline">Count</s-table-header>
                              <s-table-header listSlot="secondary">Next best action</s-table-header>
                              <s-table-header listSlot="secondary">Open</s-table-header>
                            </s-table-header-row>

                            <s-table-body>
                              {props.priorities.slice(0, 10).map((p) => (
                                <s-table-row key={p.label}>
                                  <s-table-cell>
                                    <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
                                      <ToneDot tone={(p.tone === "neutral" ? "blue" : (p.tone as any))} />
                                      <s-stack direction="block" gap="tight" style={{ minWidth: 0 }}>
                                        <s-text
                                          style={{
                                            whiteSpace: "nowrap",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            maxWidth: 520,
                                          }}
                                          title={p.label}
                                        >
                                          {p.label}
                                        </s-text>

                                        <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap", alignItems: "center" }}>
                                          {p.badge ? <s-badge tone="new">{p.badge}</s-badge> : null}
                                          {p.details ? <s-text tone="subdued">{p.details}</s-text> : null}
                                        </s-stack>
                                      </s-stack>
                                    </s-stack>
                                  </s-table-cell>

                                  <s-table-cell>
                                    <s-badge tone={badgeTone(p.tone)}>{p.count}</s-badge>
                                  </s-table-cell>

                                  <s-table-cell>
                                    <s-text
                                      tone={p.action ? "base" : "subdued"}
                                      style={{
                                        display: "block",
                                        maxWidth: 520,
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                      }}
                                      title={p.action || ""}
                                    >
                                      {p.action || "—"}
                                    </s-text>
                                  </s-table-cell>

                                  <s-table-cell>
                                    {p.href ? (
                                      <s-button href={p.href} variant="secondary">
                                        View
                                      </s-button>
                                    ) : (
                                      <s-text tone="subdued">—</s-text>
                                    )}
                                  </s-table-cell>
                                </s-table-row>
                              ))}
                            </s-table-body>
                          </s-table>
                        </s-section>
                      )}
                    </s-stack>
                  </s-section>

                  {/* Recent recoveries */}
                  <s-section>
                    <s-stack direction="block" gap="tight">
                      <SectionHeader
                        title="Recent recoveries"
                        badgeText={props.recentRecoveries?.length ? "Proof" : "None"}
                        badgeTone={props.recentRecoveries?.length ? "success" : "info"}
                      />
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
                              {props.recentRecoveries.slice(0, 6).map((r, idx) => (
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
                      <SectionHeader title="Top blockers" badgeText="7d" badgeTone="info" />
                      <s-divider />

                      {props.reasons.length === 0 ? (
                        <Empty text="No blocker data yet." />
                      ) : (
                        <s-stack direction="block" gap="tight">
                          {props.reasons.slice(0, 8).map((r) => {
                            const pct = clampPct(r.pct);
                            const t = severityToneFromPct(pct);
                            return (
                              <s-stack key={r.label} direction="inline" align="space-between" gap="base">
                                <s-text style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {r.label}
                                </s-text>
                                <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
                                  <div
                                    style={{
                                      width: 120,
                                      height: 4,
                                      borderRadius: 999,
                                      background: "rgba(0,0,0,0.08)",
                                      overflow: "hidden",
                                    }}
                                  >
                                    <div style={{ width: `${pct}%`, height: "100%", background: barColor(t) }} />
                                  </div>
                                  <s-text tone="subdued">{pct}%</s-text>
                                </s-stack>
                              </s-stack>
                            );
                          })}
                        </s-stack>
                      )}
                    </s-stack>
                  </s-section>

                  <s-section>
                    <s-stack direction="block" gap="tight">
                      <SectionHeader title="What to change next" badgeText="Settings" badgeTone="info" />
                      <s-divider />

                      {!props.recommendations || props.recommendations.length === 0 ? (
                        <Empty text="No recommendations yet." />
                      ) : (
                        <s-stack direction="block" gap="tight">
                          {props.recommendations.slice(0, 8).map((t, i) => (
                            <s-text key={`${t}-${i}`}>• {t}</s-text>
                          ))}
                        </s-stack>
                      )}
                    </s-stack>
                  </s-section>
                </s-grid>
              </s-query-container>
            </s-stack>

            {/* Right */}
            <s-stack direction="block" gap="base">
              {/* Live activity */}
              <s-section>
                <s-stack direction="block" gap="tight">
                  <SectionHeader
                    title="Live activity"
                    badgeText={props.live.length ? "Live" : "Idle"}
                    badgeTone={props.live.length ? "new" : "info"}
                  />
                  <s-divider />

                  {props.live.length === 0 ? (
                    <Empty text="No recent activity." />
                  ) : (
                    <s-section padding="none">
                      <s-table>
                        <s-table-header-row>
                          <s-table-header listSlot="primary">Event</s-table-header>
                          <s-table-header listSlot="inline">Status</s-table-header>
                          <s-table-header listSlot="secondary">When</s-table-header>
                        </s-table-header-row>
                        <s-table-body>
                          {props.live.slice(0, 10).map((r, i) => {
                            const parsed = parseLive(r.label);
                            return (
                              <s-table-row key={`${r.label}-${i}`}>
                                <s-table-cell>
                                  <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
                                    <ToneDot tone={r.tone} />
                                    <s-text>{parsed.event}</s-text>
                                  </s-stack>
                                </s-table-cell>
                                <s-table-cell>
                                  <s-badge tone={badgeTone(r.tone)}>{parsed.status}</s-badge>
                                </s-table-cell>
                                <s-table-cell>
                                  <s-text tone="subdued">{r.whenText}</s-text>
                                </s-table-cell>
                              </s-table-row>
                            );
                          })}
                        </s-table-body>
                      </s-table>
                    </s-section>
                  )}
                </s-stack>
              </s-section>

              {/* Settings snapshot */}
              {props.settingsSnapshot && props.settingsSnapshot.length ? (
                <s-section>
                  <s-stack direction="block" gap="tight">
                    <SectionHeader title="Automation settings" badgeText="Active" badgeTone="new" />
                    <s-divider />

                    <s-stack direction="block" gap="tight">
                      {props.settingsSnapshot.slice(0, 10).map((s) => (
                        <s-stack key={s.label} direction="inline" align="space-between" gap="base">
                          <s-text tone="subdued">{s.label}</s-text>
                          <s-stack direction="inline" gap="tight" style={{ alignItems: "center" }}>
                            <s-badge tone={badgeTone(s.tone ?? "neutral")}>{s.value}</s-badge>
                            {s.href ? (
                              <s-button href={s.href} variant="tertiary">
                                Edit
                              </s-button>
                            ) : null}
                          </s-stack>
                        </s-stack>
                      ))}
                    </s-stack>
                  </s-stack>
                </s-section>
              ) : null}
            </s-stack>
          </s-grid>
        </s-query-container>
      </s-stack>
    </s-page>
  );
}