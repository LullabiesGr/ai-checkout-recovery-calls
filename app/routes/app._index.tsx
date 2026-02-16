// app/routes/app._index.tsx
import * as React from "react";
import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
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
    recoveredRevenue7d: number;

    queuedCalls: number;
    callingNow: number;
    completedCalls7d: number;

    winRate7dPct: number;
  };

  live: Array<{ label: string; whenText: string; tone: "green" | "blue" | "amber" | "red" }>;
  reasons: Array<{ label: string; pct: number }>;

  recentRecoveries: Array<{ orderOrCheckout: string; amount: string; whenText: string; outcome?: string }>;
};

function withSearch(path: string) {
  if (typeof window === "undefined") return path;
  const s = window.location.search || "";
  if (!s) return path;
  if (path.includes("?")) return path;
  return `${path}${s.startsWith("?") ? s : `?${s}`}`;
}

function fromRequestWithSearch(path: string, request: Request) {
  const url = new URL(request.url);
  if (!url.search) return path;
  if (path.includes("?")) return path;
  return `${path}${url.search}`;
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

function toneForJob(status: string, outcome?: string | null): "green" | "blue" | "amber" | "red" {
  const s = String(status || "").toUpperCase();
  const o = String(outcome || "").toUpperCase();
  if (s === "FAILED") return "red";
  if (s === "CALLING") return "blue";
  if (s === "QUEUED") return "amber";
  if (s === "COMPLETED") {
    if (o.includes("RECOVER")) return "green";
    return "blue";
  }
  return "blue";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await ensureSettings(shop);

  // operational refresh (όπως το είχες)
  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
  await markAbandonedByDelay(shop, Number(settings.delayMinutes ?? 30));

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
    recentJobs,
    recentRecoveredJobs,
  ] = await Promise.all([
    db.checkout.count({ where: { shop, status: "OPEN", createdAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "ABANDONED", abandonedAt: { gte: since } } }),
    db.checkout.count({ where: { shop, status: "CONVERTED", updatedAt: { gte: since } } }),
    db.checkout.aggregate({ where: { shop, status: "ABANDONED", abandonedAt: { gte: since } }, _sum: { value: true } }),
    db.callJob.count({ where: { shop, status: "QUEUED" } }),
    db.callJob.count({ where: { shop, status: "CALLING" } }),
    db.callJob.count({ where: { shop, status: "COMPLETED", createdAt: { gte: since } } }),
    db.callJob.aggregate({ where: { shop, attributedAt: { gte: since } }, _sum: { attributedAmount: true } }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { status: true, outcome: true, checkoutId: true, updatedAt: true },
    }),
    db.callJob.findMany({
      where: { shop, attributedAt: { gte: since }, attributedOrderId: { not: null } },
      orderBy: { attributedAt: "desc" },
      take: 5,
      select: { checkoutId: true, attributedOrderId: true, attributedAmount: true, attributedAt: true, outcome: true },
    }),
  ]);

  const currency = String(settings.currency || "USD");
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);

  const potentialRevenue7d = Number(potentialAgg._sum.value ?? 0);
  const recoveredRevenue7d = Number((recoveredAgg as any)?._sum?.attributedAmount ?? 0);

  const winRate7dPct = completedCalls7d > 0 ? Math.round((convertedCount7d / completedCalls7d) * 100) : 0;

  const live = recentJobs.map((j) => ({
    label: `${j.status}${j.outcome ? ` • ${j.outcome}` : ""} • ${String(j.checkoutId).slice(0, 10)}`,
    whenText: fmtAgo(new Date(j.updatedAt)),
    tone: toneForJob(j.status, j.outcome),
  }));

  const recentRecoveries = recentRecoveredJobs.map((r) => ({
    orderOrCheckout: r.attributedOrderId ? `Order ${r.attributedOrderId}` : `Checkout ${String(r.checkoutId).slice(0, 10)}`,
    amount: money(Number(r.attributedAmount ?? 0)),
    whenText: r.attributedAt ? fmtAgo(new Date(r.attributedAt)) : "-",
    outcome: r.outcome ?? "RECOVERED",
  }));

  // blockers placeholder (δένεις μετά από tags/reasons fields)
  const reasons: Array<{ label: string; pct: number }> = [];

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
      recoveredRevenue7d,
      queuedCalls,
      callingNow,
      completedCalls7d,
      winRate7dPct,
    },
    live,
    reasons,
    recentRecoveries,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "sync_now") {
    const settings = await ensureSettings(shop);

    await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 50 });
    await markAbandonedByDelay(shop, Number(settings.delayMinutes ?? 30));

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

    return redirect(fromRequestWithSearch("/app", request));
  }

  if (intent === "create_test_call") {
    // εδώ θα βάλεις αργότερα generator για test checkout/job
    return redirect(fromRequestWithSearch("/app/calls", request));
  }

  return redirect(fromRequestWithSearch("/app", request));
};

export default function Index() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isLoading =
    (fetcher.state === "loading" || fetcher.state === "submitting") && fetcher.formMethod === "POST";

  useEffect(() => {
    // δείξε toast όταν γυρίσει από sync
    if (fetcher.data && fetcher.formData?.get("intent") === "sync_now") {
      shopify.toast.show("Synced");
    }
  }, [fetcher.data, fetcher.formData, shopify]);

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: d.currency, maximumFractionDigits: 2 }).format(n);

  const recoveredPct =
    d.stats.potentialRevenue7d > 0 ? Math.round((d.stats.recoveredRevenue7d / d.stats.potentialRevenue7d) * 100) : null;

  return (
    <DashboardView
      title="Dashboard"
      shopLabel={d.shop}
      status={{
        providerText: d.vapiConfigured ? "Vapi ready" : "Sim mode",
        automationText: d.enabled ? "Automation ON" : "Automation OFF",
        lastSyncText: isLoading ? "Syncing…" : "Up to date",
      }}
      nav={{
        checkoutsHref: withSearch("/app/checkouts"),
        callsHref: withSearch("/app/calls"),
      }}
      kpis={[
        {
          label: "Recovered revenue (7d)",
          value: money(d.stats.recoveredRevenue7d),
          sub: recoveredPct == null ? "—" : `${recoveredPct}% of at-risk`,
          tone: d.stats.recoveredRevenue7d > 0 ? "green" : "neutral",
          barPct: recoveredPct ?? null,
        },
        {
          label: "Recovered orders (7d)",
          value: String(d.stats.convertedCount7d),
          sub: "Converted checkouts",
          tone: d.stats.convertedCount7d > 0 ? "green" : "neutral",
          barPct: d.stats.winRate7dPct || null,
        },
        {
          label: "Win rate (7d)",
          value: `${d.stats.winRate7dPct}%`,
          sub: "Recovered / Completed",
          tone: d.stats.winRate7dPct >= 20 ? "blue" : d.stats.winRate7dPct > 0 ? "amber" : "neutral",
          barPct: d.stats.winRate7dPct,
        },
        {
          label: "At-risk revenue (7d)",
          value: money(d.stats.potentialRevenue7d),
          sub: "Abandoned carts total",
          tone: d.stats.potentialRevenue7d > 0 ? "amber" : "neutral",
          barPct: 100,
        },
        {
          label: "Calls queued",
          value: String(d.stats.queuedCalls),
          sub: "Ready to dial",
          tone: d.stats.queuedCalls > 0 ? "amber" : "neutral",
          barPct: d.stats.queuedCalls > 0 ? 70 : 10,
        },
        {
          label: "Calling now",
          value: String(d.stats.callingNow),
          sub: "Live calls",
          tone: d.stats.callingNow > 0 ? "blue" : "neutral",
          barPct: d.stats.callingNow > 0 ? 70 : 10,
        },
      ]}
      pipeline={[
        { label: "Open", value: d.stats.openCount7d, tone: "blue" },
        { label: "Abandoned", value: d.stats.abandonedCount7d, tone: "amber" },
        { label: "Queued", value: d.stats.queuedCalls, tone: "amber" },
        { label: "Calling", value: d.stats.callingNow, tone: "blue" },
        { label: "Completed (7d)", value: d.stats.completedCalls7d, tone: "blue" },
        { label: "Recovered (7d)", value: d.stats.convertedCount7d, tone: "green" },
      ]}
      live={d.live}
      reasons={d.reasons}
      recentRecoveries={d.recentRecoveries}
      recommendations={[]}
      canCreateTestCall={d.vapiConfigured}
    />
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
