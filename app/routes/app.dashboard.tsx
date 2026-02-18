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
  // keep it simple/clean (no "4520 USD" glued)
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureSettings(shop);

  const [checkouts, jobs] = await Promise.all([
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

  // KPIs (make them feel like the “old” dashboard: strong tones, meaningful bars)
  const winRatePct = totalCheckouts ? pct(recoveredCount, totalCheckouts) : 0;

  const atRiskSharePct = abandonedValue > 0 ? pct(recoveredValue, recoveredValue + abandonedValue) : 0;

  const kpiRecoveredBar = clampPct(Math.max(10, atRiskSharePct)); // avoid “empty bar” look
  const kpiAtRiskBar = clampPct(Math.max(10, 100 - atRiskSharePct));

  const callsCompletedBar = pct(completedCalls, Math.max(1, completedCalls + activeCalls + failedCalls));
  const callsActiveBar = pct(activeCalls, Math.max(1, completedCalls + activeCalls + failedCalls));

  // Pipeline tones
  const pipeline = [
    { label: "Open", value: openCount, tone: "blue" as const },
    { label: "Abandoned", value: abandonedCount, tone: abandonedCount ? ("red" as const) : ("amber" as const) },
    { label: "Queued", value: queuedCalls, tone: queuedCalls ? ("amber" as const) : ("blue" as const) },
    { label: "Calling", value: callingCalls, tone: callingCalls ? ("blue" as const) : ("amber" as const) },
    { label: "Completed", value: completedCalls, tone: completedCalls ? ("green" as const) : ("blue" as const) },
    { label: "Recovered", value: recoveredCount, tone: recoveredCount ? ("green" as const) : ("amber" as const) },
  ];

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

      // This is what makes the UI look “right”.
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

      // keep placeholders but show realistic distribution if you want later from outcomes table
      reasons: [
        { label: "No answer", pct: 0 },
        { label: "Voicemail", pct: 0 },
        { label: "Needs follow-up", pct: 0 },
        { label: "Not interested", pct: 0 },
      ],

      priorities: [
        {
          label: "Review failed calls",
          count: failedCalls,
          tone: failedCalls ? "red" : "neutral",
          href: `/app/calls${search}`,
        },
        {
          label: "Work abandoned checkouts",
          count: abandonedCount,
          tone: abandonedCount ? "amber" : "neutral",
          href: `/app/checkouts${search}`,
        },
      ],

      recentRecoveries: [],

      recommendations: [
        "Enable/verify checkout webhooks in Shopify app settings.",
        "Confirm phone normalization and country code handling.",
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
