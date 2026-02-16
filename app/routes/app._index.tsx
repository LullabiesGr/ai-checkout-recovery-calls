// app/routes/app._index.tsx
import * as React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  ensureSettings,
  markAbandonedByDelay,
  syncAbandonedCheckoutsFromShopify,
  enqueueCallJobs,
} from "../callRecovery.server";
import { DashboardView } from "../components/dashboard/DashboardView";

type LoaderData = {
  shop: string;
  currency: string;
  vapiConfigured: boolean;
  enabled: boolean;
  stats: {
    openCount7d: number;
    abandonedCount7d: number;
    convertedCount7d: number;

    potentialRevenue7d: number;

    queuedCalls: number;
    callingNow: number;
    completedCalls7d: number;

    recoveredRevenue7d: number;
    recoveredOrders7d: number;
    winRate7d: number;
  };

  live: Array<{ label: string; whenText: string; tone: "green" | "blue" | "amber" | "red" }>;
  reasons: Array<{ label: string; pct: number }>;

  recentRecoveries: Array<{ orderOrCheckout: string; amount: string; whenText: string; outcome?: string }>;
  recommendations: string[];
};

function safeSearch(): string {
  if (typeof window === "undefined") return "";
  const s = window.location.search || "";
  return s.startsWith("?") ? s : s ? `?${s}` : "";
}
function withSearch(path: string): string {
  const s = safeSearch();
  if (!s) return path;
  if (path.includes("?")) return path;
  return `${path}${s}`;
}

function fmtAgo(d: Date) {
  const ms = Date.now() - d.getTime();
  const sec = Math.max(1, Math.floor(ms / 1000));
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return `${sec}s ago`;
}

function toneForStatus(status: string): "green" | "blue" | "amber" | "red" {
  const s = String(status || "").toUpperCase();
  if (s.includes("FAIL") || s.includes("ERROR") || s.includes("CANCEL")) return "red";
  if (s.includes("QUEUE") || s.includes("RETRY") || s.includes("SCHEDULE")) return "amber";
  if (s.includes("CALL")) return "blue";
  if (s.includes("COMPLETE") || s.includes("DONE") || s.includes("SUCCESS")) return "green";
  return "blue";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "sync_now") {
    const settings = await ensureSettings(shop);

    await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
    await markAbandonedByDelay(shop, settings.delayMinutes);

    await enqueueCallJobs({
      shop,
      enabled: Boolean(settings.enabled),
      minOrderValue: Number(settings.minOrderValue ?? 0),
      callWindowStart: String(settings.callWindowStart ?? "09:00"),
      callWindowEnd: String(settings.callWindowEnd ?? "19:00"),
      delayMinutes: Number(settings.delayMinutes ?? 30),
      maxAttempts: Number(settings.maxAttempts ?? 2),
      retryMinutes: Number(settings.retryMinutes ?? 180),
    });

    const url = new URL(request.url);
    return redirect(`/app${url.search}`);
  }

  // create_test_call: άστο disabled μέχρι να έχεις “test checkout/job” generator.
  return { ok: true };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  // Keep the “always fresh” behavior (όπως το είχες)
  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
  await markAbandonedByDelay(shop, settings.delayMinutes);

  await enqueueCallJobs({
    shop,
    enabled: Boolean(settings.enabled),
    minOrderValue: Number(settings.minOrderValue ?? 0),
    callWindowStart: String(settings.callWindowStart ?? "09:00"),
    callWindowEnd: String(settings.callWindowEnd ?? "19:00"),
    delayMinutes: Number(settings.delayMinutes ?? 30),
    maxAttempts: Number(settings.maxAttempts ?? 2),
    retryMinutes: Number(settings.retryMinutes ?? 180),
  });

  const { isVapiConfiguredFromEnv } = await import("../lib/callInsights.server");
  const vapiConfigured = isVapiConfiguredFromEnv();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    openCount7d,
    abandonedCount7d,
    convertedCount7d,
    potentialAgg,
    queuedCalls,
    callingNow,
    completedCalls7d,

    recoveredAgg,
    recoveredOrders7d,
    recentRecoveredJobs,
    recentJobs,
    reasonRows,
  ] = await Promise.all([
    db.checkout.count({ where: { shop, status: "OPEN", createdAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "ABANDONED", abandonedAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "CONVERTED", updatedAt: { gte: since } } }),
    db.checkout.aggregate({
      where: { shop, status: "ABANDONED", abandonedAt: { gte: since } },
      _sum: { value: true },
    }),
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),

    db.callJob.aggregate({
      where: { shop, attributedAt: { gte: since } },
      _sum: { attributedAmount: true },
    }),
    db.callJob.count({
      where: { shop, attributedAt: { gte: since }, attributedOrderId: { not: null } },
    }),
    db.callJob.findMany({
      where: { shop, attributedAt: { gte: since }, attributedOrderId: { not: null } },
      orderBy: { attributedAt: "desc" },
      take: 5,
      select: {
        checkoutId: true,
        attributedOrderId: true,
        attributedAmount: true,
        attributedAt: true,
        outcome: true,
      },
    }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { status: true, checkoutId: true, updatedAt: true },
    }),
    db.callJob.findMany({
      where: { shop, createdAt: { gte: since }, reason: { not: null } },
      select: { reason: true },
      take: 500,
    }),
  ]);

  const currency = settings.currency || "USD";
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);

  const potentialRevenue7d = Number(potentialAgg._sum.value ?? 0);
  const recoveredRevenue7d = Number(recoveredAgg._sum.attributedAmount ?? 0);
  const winRate7d = completedCalls7d > 0 ? Math.round((recoveredOrders7d / completedCalls7d) * 100) : 0;

  const live = recentJobs.map((j) => ({
    label: `${j.status} • Checkout ${j.checkoutId}`,
    whenText: fmtAgo(new Date(j.updatedAt)),
    tone: toneForStatus(j.status),
  }));

  const reasonCounts = new Map<string, number>();
  for (const r of reasonRows) {
    const key = String(r.reason ?? "").trim();
    if (!key) continue;
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  const totalReasons = Array.from(reasonCounts.values()).reduce((a, b) => a + b, 0) || 0;
  const reasons = Array.from(reasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, count]) => ({
      label,
      pct: totalReasons ? Math.round((count / totalReasons) * 100) : 0,
    }));

  const recentRecoveries = recentRecoveredJobs.map((r) => ({
    orderOrCheckout: r.attributedOrderId ? `Order ${r.attributedOrderId}` : `Checkout ${r.checkoutId}`,
    amount: money(Number(r.attributedAmount ?? 0)),
    whenText: r.attributedAt ? fmtAgo(new Date(r.attributedAt)) : "-",
    outcome: r.outcome ?? undefined,
  }));

  const recommendations: string[] = [];
  if (!settings.enabled) recommendations.push("Enable automation to start dialing automatically.");
  if (!vapiConfigured) recommendations.push("Connect Vapi in Settings to place real calls.");
  if (abandonedCount7d > 0 && queuedCalls === 0) recommendations.push("Queue is empty while carts are abandoned: check call window, min order value, and delay settings.");
  if (callingNow > 0) recommendations.push("Live calls running now: check Calls tab for outcomes and next actions.");

  return {
    shop,
    currency,
    vapiConfigured,
    enabled: Boolean(settings.enabled),
    stats: {
      openCount7d,
      abandonedCount7d,
      convertedCount7d,
      potentialRevenue7d,
      queuedCalls,
      callingNow,
      completedCalls7d,
      recoveredRevenue7d,
      recoveredOrders7d,
      winRate7d,
    },
    live,
    reasons,
    recentRecoveries,
    recommendations,
  } satisfies LoaderData;
};

export default function DashboardIndex() {
  const d = useLoaderData<typeof loader>();

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: d.currency, maximumFractionDigits: 2 }).format(n);

  const recoveredPct =
    d.stats.potentialRevenue7d > 0 ? Math.round((d.stats.recoveredRevenue7d / d.stats.potentialRevenue7d) * 100) : null;

  const kpis = [
    {
      label: "Recovered revenue (7d)",
      value: money(d.stats.recoveredRevenue7d),
      sub: recoveredPct == null ? "—" : `${recoveredPct}% of at-risk`,
      tone: d.stats.recoveredRevenue7d > 0 ? ("green" as const) : ("neutral" as const),
      barPct: recoveredPct ?? null,
    },
    {
      label: "Recovered orders (7d)",
      value: String(d.stats.recoveredOrders7d),
      sub: "Attributed to calls",
      tone: d.stats.recoveredOrders7d > 0 ? ("green" as const) : ("neutral" as const),
      barPct: d.stats.completedCalls7d ? Math.round((d.stats.recoveredOrders7d / d.stats.completedCalls7d) * 100) : null,
    },
    {
      label: "Win rate (7d)",
      value: `${d.stats.winRate7d}%`,
      sub: "Recovered / Completed",
      tone: d.stats.winRate7d >= 20 ? ("blue" as const) : d.stats.winRate7d > 0 ? ("amber" as const) : ("neutral" as const),
      barPct: d.stats.winRate7d,
    },
    {
      label: "At-risk revenue (7d)",
      value: money(d.stats.potentialRevenue7d),
      sub: "Abandoned carts total",
      tone: d.stats.potentialRevenue7d > 0 ? ("amber" as const) : ("neutral" as const),
      barPct: 100,
    },
    {
      label: "Calls queued",
      value: String(d.stats.queuedCalls),
      sub: "Ready to dial",
      tone: d.stats.queuedCalls > 0 ? ("amber" as const) : ("neutral" as const),
      barPct: d.stats.queuedCalls > 0 ? 70 : 10,
    },
    {
      label: "Calling now",
      value: String(d.stats.callingNow),
      sub: "Live calls",
      tone: d.stats.callingNow > 0 ? ("blue" as const) : ("neutral" as const),
      barPct: d.stats.callingNow > 0 ? 70 : 10,
    },
  ];

  const pipeline = [
    { label: "Open", value: d.stats.openCount7d, tone: "blue" as const },
    { label: "Abandoned", value: d.stats.abandonedCount7d, tone: "amber" as const },
    { label: "Queued", value: d.stats.queuedCalls, tone: "amber" as const },
    { label: "Calling", value: d.stats.callingNow, tone: "blue" as const },
    { label: "Completed (7d)", value: d.stats.completedCalls7d, tone: "green" as const },
    { label: "Recovered (7d)", value: d.stats.recoveredOrders7d, tone: "green" as const },
  ];

  const priorities = [
    { label: "Run queue now", count: d.stats.queuedCalls, tone: d.stats.queuedCalls ? ("amber" as const) : ("neutral" as const), href: withSearch("/app/calls") },
    { label: "Live calls", count: d.stats.callingNow, tone: d.stats.callingNow ? ("blue" as const) : ("neutral" as const), href: withSearch("/app/calls") },
    { label: "Highest at-risk carts", count: d.stats.abandonedCount7d, tone: d.stats.abandonedCount7d ? ("amber" as const) : ("neutral" as const), href: withSearch("/app/checkouts") },
  ];

  return (
    <div style={{ padding: 16 }}>
      <DashboardView
        title="Dashboard"
        shopLabel={d.shop}
        status={{
          providerText: d.vapiConfigured ? "Vapi ready" : "Sim mode",
          automationText: d.enabled ? "Automation ON" : "Automation OFF",
          lastSyncText: "Just now",
        }}
        nav={{
          checkoutsHref: withSearch("/app/checkouts"),
          callsHref: withSearch("/app/calls"),
        }}
        kpis={kpis}
        pipeline={pipeline}
        live={d.live}
        reasons={d.reasons}
        priorities={priorities}
        recentRecoveries={d.recentRecoveries}
        recommendations={d.recommendations}
        canCreateTestCall={false}
      />
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
