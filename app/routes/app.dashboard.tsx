// app/routes/app.dashboard.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

import { DashboardView } from "../components/dashboard/DashboardView";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";

function safeSearch(requestUrl: string) {
  const url = new URL(requestUrl);
  return url.search || "";
}

function fmtMoney(amount: number, currency: string) {
  const v = Number.isFinite(amount) ? amount : 0;
  const cur = (currency || "USD").toUpperCase();
  try {
    const nf = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 2,
    });
    return nf.format(v);
  } catch {
    return `${Math.round(v)} ${cur}`;
  }
}

function minutesAgo(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const m = Math.max(0, Math.round(diffMs / 60000));
  if (m <= 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function clampPct(n: number) {
  return Math.max(0, Math.min(100, n));
}

function pct(part: number, whole: number) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return clampPct(Math.round((part / whole) * 100));
}

function toneForRate(ratePct: number): "green" | "blue" | "amber" | "red" {
  if (ratePct >= 25) return "green";
  if (ratePct >= 12) return "blue";
  if (ratePct >= 5) return "amber";
  return "red";
}

/* ---------------- Supabase: vapi_call_summaries (dashboard) ---------------- */
type SummaryLite = {
  last_received_at?: string | null;
  received_at?: string | null;
  checkout_id?: string | null;
  call_outcome?: string | null;
  buy_probability?: number | null;
  next_best_action?: string | null;
  best_next_action?: string | null;
  follow_up_message?: string | null;
  discount_suggest?: boolean | null;
  discount_percent?: number | null;
  human_intervention?: boolean | null;
  human_intervention_reason?: string | null;
  ai_status?: string | null;
  ai_result?: string | null;
  customer_name?: string | null;
  customer_intent?: string | null;
  tagcsv?: string | null;
  tags?: any;
  recording_url?: string | null;
  log_url?: string | null;
};

function pickText(v: unknown) {
  return String(v ?? "").trim();
}

function dayStartIsoUtc() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function modeNonEmpty(values: Array<string | null | undefined>) {
  const m = new Map<string, number>();
  for (const v of values) {
    const s = pickText(v);
    if (!s) continue;
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [k, n] of m.entries()) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

async function fetchTodaySummaries(shop: string): Promise<SummaryLite[]> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return [];

  const sinceIso = dayStartIsoUtc();

  const select = [
    "last_received_at",
    "received_at",
    "checkout_id",
    "call_outcome",
    "buy_probability",
    "next_best_action",
    "best_next_action",
    "follow_up_message",
    "discount_suggest",
    "discount_percent",
    "human_intervention",
    "human_intervention_reason",
    "ai_status",
    "ai_result",
    "customer_name",
    "customer_intent",
    "tagcsv",
    "tags",
    "recording_url",
    "log_url",
  ].join(",");

  const params = new URLSearchParams();
  params.set("select", select);
  params.set("shop", `eq.${shop}`);
  // supabase filter: last_received_at >= today start (utc)
  params.set("last_received_at", `gte.${sinceIso}`);
  params.set("order", "last_received_at.desc,received_at.desc");
  params.set("limit", "200");

  const endpoint = `${url}/rest/v1/vapi_call_summaries?${params.toString()}`;
  const r = await fetch(endpoint, {
    method: "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  });

  if (!r.ok) return [];
  const data = (await r.json()) as SummaryLite[];
  return Array.isArray(data) ? data : [];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureSettings(shop);

  const [checkouts, jobs, todaySummaries] = await Promise.all([
    db.checkout.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        status: true,
        value: true,
        currency: true,
        updatedAt: true,
        createdAt: true,
      },
    }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        status: true,
        createdAt: true,
        scheduledFor: true,
        attempts: true,
      },
    }),
    fetchTodaySummaries(shop),
  ]);

  const search = safeSearch(request.url);

  const currency = (checkouts.find((c) => c.currency)?.currency ?? "USD").toUpperCase();
  const totalCheckouts = checkouts.length;

  const isAbandoned = (s: unknown) => String(s ?? "").toUpperCase() === "ABANDONED";
  const isOpen = (s: unknown) => String(s ?? "").toUpperCase() === "OPEN";
  const isRecovered = (s: unknown) => {
    const v = String(s ?? "").toUpperCase();
    return v === "RECOVERED" || v === "CONVERTED";
  };

  const abandonedCount = checkouts.filter((c) => isAbandoned(c.status)).length;
  const openCount = checkouts.filter((c) => isOpen(c.status)).length;
  const recoveredCount = checkouts.filter((c) => isRecovered(c.status)).length;

  const abandonedValue = checkouts
    .filter((c) => isAbandoned(c.status))
    .reduce((sum, c) => sum + Number(c.value ?? 0), 0);

  const recoveredValue = checkouts
    .filter((c) => isRecovered(c.status))
    .reduce((sum, c) => sum + Number(c.value ?? 0), 0);

  const completedCalls = jobs.filter((j) => String(j.status).toUpperCase() === "COMPLETED").length;
  const failedCalls = jobs.filter((j) => String(j.status).toUpperCase() === "FAILED").length;

  const callingCalls = jobs.filter((j) => String(j.status).toUpperCase() === "CALLING").length;
  const queuedCalls = jobs.filter((j) => String(j.status).toUpperCase() === "QUEUED").length;
  const activeCalls = queuedCalls + callingCalls;

  const lastSyncIso =
    (checkouts[0]?.updatedAt ? new Date(checkouts[0].updatedAt).toISOString() : null) ??
    (jobs[0]?.createdAt ? new Date(jobs[0].createdAt).toISOString() : null);

  const winRatePct = totalCheckouts ? pct(recoveredCount, totalCheckouts) : 0;

  const atRiskSharePct = abandonedValue > 0 ? pct(recoveredValue, recoveredValue + abandonedValue) : 0;

  const kpiRecoveredBar = clampPct(Math.max(10, atRiskSharePct));
  const kpiAtRiskBar = clampPct(Math.max(10, 100 - atRiskSharePct));

  const callsCompletedBar = pct(completedCalls, Math.max(1, completedCalls + activeCalls + failedCalls));
  const callsActiveBar = pct(activeCalls, Math.max(1, completedCalls + activeCalls + failedCalls));

  const pipeline = [
    { label: "Open", value: openCount, tone: "blue" as const },
    { label: "Abandoned", value: abandonedCount, tone: abandonedCount ? ("red" as const) : ("amber" as const) },
    { label: "Queued", value: queuedCalls, tone: queuedCalls ? ("amber" as const) : ("blue" as const) },
    { label: "Calling", value: callingCalls, tone: callingCalls ? ("blue" as const) : ("amber" as const) },
    { label: "Completed", value: completedCalls, tone: completedCalls ? ("green" as const) : ("blue" as const) },
    { label: "Recovered", value: recoveredCount, tone: recoveredCount ? ("green" as const) : ("amber" as const) },
  ];

  // ---------- Today’s priorities from outcomes table ----------
  const norm = (s: unknown) => String(s ?? "").toLowerCase();
  const today = todaySummaries;

  const needsFollowUp = today.filter((r) => {
    const outcome = norm(r.call_outcome);
    const aiResult = norm(r.ai_result);
    return (
      aiResult.includes("needs_follow") ||
      outcome.includes("needs_follow") ||
      !!pickText(r.follow_up_message) ||
      !!pickText(r.next_best_action) ||
      !!pickText(r.best_next_action)
    );
  });

  const discountRequests = today.filter((r) => {
    const tags = norm(r.tagcsv);
    const outcome = norm(r.call_outcome);
    return Boolean(r.discount_suggest) || tags.includes("discount") || outcome.includes("discount");
  });

  const humanIntervention = today.filter((r) => Boolean(r.human_intervention));

  const highIntent = today.filter((r) => {
    const p = typeof r.buy_probability === "number" ? r.buy_probability : NaN;
    if (!Number.isFinite(p)) return false;
    // clamp to 0..100 stored; treat >= 70 as “hot”
    return p >= 70;
  });

  const priorityRows = [
    {
      key: "followups",
      label: "Send follow-ups",
      count: needsFollowUp.length,
      tone: needsFollowUp.length ? "amber" : "neutral",
      sampleAction: modeNonEmpty(needsFollowUp.map((x) => x.next_best_action || x.best_next_action)),
      href: `/app/checkouts${search}`,
    },
    {
      key: "highintent",
      label: "Work high-intent leads",
      count: highIntent.length,
      tone: highIntent.length ? "blue" : "neutral",
      sampleAction: modeNonEmpty(highIntent.map((x) => x.next_best_action || x.best_next_action)),
      href: `/app/checkouts${search}`,
    },
    {
      key: "discount",
      label: "Handle discount requests",
      count: discountRequests.length,
      tone: discountRequests.length ? "amber" : "neutral",
      sampleAction: modeNonEmpty(discountRequests.map((x) => x.next_best_action || x.best_next_action)),
      href: `/app/checkouts${search}`,
    },
    {
      key: "human",
      label: "Human intervention needed",
      count: humanIntervention.length,
      tone: humanIntervention.length ? "red" : "neutral",
      sampleAction: modeNonEmpty(humanIntervention.map((x) => x.human_intervention_reason || x.next_best_action || x.best_next_action)),
      href: `/app/checkouts${search}`,
    },
    {
      key: "failed",
      label: "Review failed calls",
      count: failedCalls,
      tone: failedCalls ? "red" : "neutral",
      sampleAction: "Retry with backoff + verify phone number formatting",
      href: `/app/calls${search}`,
    },
    {
      key: "abandoned",
      label: "Work abandoned checkouts",
      count: abandonedCount,
      tone: abandonedCount ? "amber" : "neutral",
      sampleAction: "Call high-value carts first; apply AI next-best action",
      href: `/app/checkouts${search}`,
    },
  ].filter((r) => r.label);

  // compact “Today outcomes” table rows
  const todayOutcomeRows = today.slice(0, 15).map((r) => {
    const whenIso = pickText(r.last_received_at || r.received_at);
    return {
      checkoutId: pickText(r.checkout_id) || "—",
      customer: pickText(r.customer_name) || "—",
      outcome: pickText(r.call_outcome) || "—",
      buyPct:
        typeof r.buy_probability === "number" && Number.isFinite(r.buy_probability)
          ? `${Math.round(r.buy_probability)}%`
          : "—",
      nextAction: pickText(r.next_best_action || r.best_next_action) || "—",
      followUp: pickText(r.follow_up_message) || "—",
      whenText: whenIso ? minutesAgo(new Date(whenIso).toISOString()) : "—",
      recordingUrl: pickText(r.recording_url) || "",
      logUrl: pickText(r.log_url) || "",
    };
  });

  return {
    shop,
    search,
    view: {
      title: "Dashboard",
      shopLabel: shop,
      status: {
        providerText: "Vapi ready",
        automationText: "Automation ON",
        lastSyncText: lastSyncIso ? minutesAgo(lastSyncIso) : "—",
      },
      nav: {
        checkoutsHref: `/app/checkouts${search}`,
        callsHref: `/app/calls${search}`,
      },

      kpis: [
        {
          label: "Recovered revenue",
          value: fmtMoney(recoveredValue, currency),
          sub: "All-time",
          tone: recoveredValue > 0 ? "green" : "blue",
          barPct: kpiRecoveredBar,
        },
        {
          label: "At-risk revenue",
          value: fmtMoney(abandonedValue, currency),
          sub: "Abandoned carts",
          tone: abandonedValue > 0 ? "amber" : "neutral",
          barPct: kpiAtRiskBar,
        },
        {
          label: "Win rate",
          value: totalCheckouts ? `${winRatePct}%` : "—",
          sub: "Recovered / total",
          tone: totalCheckouts ? toneForRate(winRatePct) : "neutral",
          barPct: totalCheckouts ? winRatePct : 0,
        },
        {
          label: "Abandoned checkouts",
          value: String(abandonedCount),
          sub: "Count",
          tone: abandonedCount > 0 ? "red" : "neutral",
          barPct: totalCheckouts ? pct(abandonedCount, totalCheckouts) : 0,
        },
        {
          label: "Calls completed",
          value: String(completedCalls),
          sub: "Count",
          tone: completedCalls > 0 ? "green" : "neutral",
          barPct: callsCompletedBar || (completedCalls ? 40 : 0),
        },
        {
          label: "Calls active",
          value: String(activeCalls),
          sub: callingCalls ? "Calling" : "Queued",
          tone: activeCalls > 0 ? "blue" : "neutral",
          barPct: callsActiveBar || (activeCalls ? 35 : 0),
        },
      ],

      pipeline,

      live: jobs.slice(0, 10).map((j) => {
        const st = String(j.status).toUpperCase();
        const tone =
          st === "FAILED" ? "red" : st === "COMPLETED" ? "green" : st === "CALLING" ? "blue" : "amber";
        return {
          label: `Call ${st} (attempts ${j.attempts ?? 0})`,
          whenText: minutesAgo(new Date(j.createdAt).toISOString()),
          tone,
        };
      }),

      reasons: [
        { label: "No answer", pct: 0 },
        { label: "Voicemail", pct: 0 },
        { label: "Needs follow-up", pct: 0 },
        { label: "Not interested", pct: 0 },
      ],

      priorities: priorityRows.map((p) => ({
        label: p.label,
        count: p.count,
        tone: p.tone,
        href: p.href,
        nextBestAction: p.sampleAction || "—",
      })),

      todayOutcomes: todayOutcomeRows,

      recentRecoveries: [],

      recommendations: [
        "Route follow-up messages into an email/SMS action and mark as sent.",
        "Auto-prioritize by buy probability + cart value + objection type.",
        "Add retry rules for failed calls (attempts + backoff).",
      ],

      canCreateTestCall: true,
    },
  };
};

export default function DashboardRoute() {
  const data = useLoaderData<typeof loader>();
  return <DashboardView {...data.view} />;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);