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
  return `${Math.round(v)} ${cur}`;
}

function minutesAgo(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  const m = Math.max(0, Math.round(diffMs / 60000));
  if (m <= 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureSettings(shop);

  const [checkouts, jobs] = await Promise.all([
    db.checkout.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 250,
      select: {
        status: true,
        value: true,
        currency: true,
        updatedAt: true,
      },
    }),
    db.callJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 250,
      select: {
        status: true,
        createdAt: true,
        scheduledFor: true,
        attempts: true,
      },
    }),
  ]);

  const currency = (checkouts.find((c) => c.currency)?.currency ?? "USD").toUpperCase();

  const totalCheckouts = checkouts.length;
  const abandoned = checkouts.filter((c) => String(c.status).toUpperCase() === "ABANDONED").length;
  const open = checkouts.filter((c) => String(c.status).toUpperCase() === "OPEN").length;
  const recovered = checkouts.filter((c) => {
    const s = String(c.status).toUpperCase();
    return s === "RECOVERED" || s === "CONVERTED";
  }).length;

  const abandonedValue = checkouts
    .filter((c) => String(c.status).toUpperCase() === "ABANDONED")
    .reduce((sum, c) => sum + Number(c.value ?? 0), 0);

  const recoveredValue = checkouts
    .filter((c) => {
      const s = String(c.status).toUpperCase();
      return s === "RECOVERED" || s === "CONVERTED";
    })
    .reduce((sum, c) => sum + Number(c.value ?? 0), 0);

  const completedCalls = jobs.filter((j) => String(j.status).toUpperCase() === "COMPLETED").length;
  const failedCalls = jobs.filter((j) => String(j.status).toUpperCase() === "FAILED").length;
  const queuedCalls = jobs.filter((j) => {
    const s = String(j.status).toUpperCase();
    return s === "QUEUED" || s === "CALLING";
  }).length;

  const lastSyncIso =
    (checkouts[0]?.updatedAt ? new Date(checkouts[0].updatedAt).toISOString() : null) ??
    (jobs[0]?.createdAt ? new Date(jobs[0].createdAt).toISOString() : null);

  const search = safeSearch(request.url);

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
        { label: "Recovered revenue", value: fmtMoney(recoveredValue, currency), sub: "All-time", tone: "green", barPct: 60 },
        { label: "At-risk revenue", value: fmtMoney(abandonedValue, currency), sub: "Abandoned", tone: "amber", barPct: 55 },
        {
          label: "Win rate",
          value: totalCheckouts ? `${Math.round((recovered / totalCheckouts) * 100)}%` : "—",
          sub: "Recovered / total",
          tone: "blue",
          barPct: totalCheckouts ? Math.round((recovered / totalCheckouts) * 100) : 40,
        },
        {
          label: "Abandoned checkouts",
          value: String(abandoned),
          sub: "Count",
          tone: "red",
          barPct: totalCheckouts ? Math.round((abandoned / totalCheckouts) * 100) : 40,
        },
        { label: "Calls completed", value: String(completedCalls), sub: "Count", tone: "green", barPct: 50 },
        { label: "Calls queued", value: String(queuedCalls), sub: "Queued/Calling", tone: "blue", barPct: 45 },
      ],
      pipeline: [
        { label: "Open", value: open, tone: "blue" },
        { label: "Abandoned", value: abandoned, tone: "red" },
        { label: "Calls queued", value: queuedCalls, tone: "amber" },
        { label: "Calls completed", value: completedCalls, tone: "green" },
        { label: "Calls failed", value: failedCalls, tone: "red" },
        { label: "Recovered", value: recovered, tone: "green" },
      ],
      live: jobs.slice(0, 10).map((j) => ({
        label: `Call ${String(j.status).toUpperCase()} (attempts ${j.attempts ?? 0})`,
        whenText: minutesAgo(new Date(j.createdAt).toISOString()),
        tone: (String(j.status).toUpperCase() === "FAILED"
          ? "red"
          : String(j.status).toUpperCase() === "COMPLETED"
          ? "green"
          : "amber") as any,
      })),
      reasons: [
        { label: "No answer", pct: 0 },
        { label: "Voicemail", pct: 0 },
        { label: "Needs follow-up", pct: 0 },
        { label: "Not interested", pct: 0 },
      ],
      priorities: [
        { label: "Review failed calls", count: failedCalls, tone: failedCalls ? "red" : "neutral", href: `/app/calls${search}` },
        { label: "Work abandoned checkouts", count: abandoned, tone: abandoned ? "amber" : "neutral", href: `/app/checkouts${search}` },
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
