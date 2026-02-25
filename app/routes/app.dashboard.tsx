// app/routes/app.dashboard.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";
import { DashboardView, type DashboardViewProps } from "../components/dashboard/DashboardView";

type RangeKey = "all" | "7d" | "24h";

function safeSearch(requestUrl: string) {
  const url = new URL(requestUrl);
  return url.search || "";
}

function stripParam(search: string, key: string) {
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  sp.delete(key);
  const out = sp.toString();
  return out ? `?${out}` : "";
}

function setParam(search: string, key: string, value: string) {
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  sp.set(key, value);
  const out = sp.toString();
  return out ? `?${out}` : "";
}

function appendParam(url: string, key: string, value: string) {
  const u = new URL(url, "http://local");
  u.searchParams.set(key, value);
  return u.pathname + (u.search ? u.search : "");
}

function fmtMoney(amount: number, currency: string) {
  const v = Number.isFinite(amount) ? amount : 0;
  const cur = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${cur}`;
  }
}

function pct(part: number, whole: number) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
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

function normUpper(v: unknown) {
  return String(v ?? "").toUpperCase();
}
function normLower(v: unknown) {
  return String(v ?? "").toLowerCase();
}

/**
 * VERIFIED recovery = we have an order id or a positive recovered amount.
 * DO NOT trust status="RECOVERED" alone (AI/call outcome can set it incorrectly).
 */
function isVerifiedRecoveredCheckoutRow(c: any) {
  const hasOrder = Boolean(c?.recoveredOrderId);
  const amt = Number(c?.recoveredAmount ?? 0);
  return hasOrder || amt > 0;
}

function checkoutTimeFilter(start: Date, end: Date) {
  return {
    OR: [
      { updatedAt: { gte: start, lt: end } },
      { createdAt: { gte: start, lt: end } },
      { abandonedAt: { gte: start, lt: end } },
      { recoveredAt: { gte: start, lt: end } },
    ],
  } as const;
}

function windowFromRange(range: RangeKey) {
  const now = new Date();
  if (range === "24h") {
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const prevStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    return { range, now, start, prevStart, prevEnd: start };
  }
  if (range === "7d") {
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { range, now, start, prevStart, prevEnd: start };
  }
  return { range, now, start: null as Date | null, prevStart: null as Date | null, prevEnd: null as Date | null };
}

/* ---------------- Supabase vapi_call_summaries helpers ---------------- */
type VapiRow = {
  received_at: string | null;
  call_id: string | null;
  checkout_id: string | null;
  call_job_id: string | null;

  answered: boolean | null;
  voicemail: boolean | null;
  sentiment: string | null;

  call_outcome: string | null;
  disposition: string | null;

  buy_probability: number | null;
  customer_intent: string | null;

  objections_text: string | null;
  next_best_action: string | null;
  follow_up_message: string | null;

  tags: any;
  tagcsv: string | null;

  discount_suggest: boolean | null;
  discount_percent: number | null;
  discount_rationale: string | null;

  summary_clean: string | null;
  transcript: string | null;

  recording_url: string | null;
  log_url: string | null;

  ended_reason: string | null;

  ai_status: string | null;
  ai_error: string | null;
  ai_processed_at: string | null;

  ai_insights: any;
  structured_outputs: any;
};

function supabaseEnv() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

async function supabaseCount(params: URLSearchParams): Promise<number> {
  const env = supabaseEnv();
  if (!env) return 0;

  params.set("select", "call_id");
  params.set("limit", "1");

  const endpoint = `${env.url}/rest/v1/vapi_call_summaries?${params.toString()}`;
  const r = await fetch(endpoint, {
    method: "GET",
    headers: {
      apikey: env.key,
      authorization: `Bearer ${env.key}`,
      prefer: "count=exact",
      "content-type": "application/json",
    },
  });

  const cr = r.headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)\s*$/);
  if (m?.[1]) return Number(m[1]) || 0;
  return 0;
}

async function supabaseFetchRows(params: URLSearchParams): Promise<VapiRow[]> {
  const env = supabaseEnv();
  if (!env) return [];

  const endpoint = `${env.url}/rest/v1/vapi_call_summaries?${params.toString()}`;
  const r = await fetch(endpoint, {
    method: "GET",
    headers: {
      apikey: env.key,
      authorization: `Bearer ${env.key}`,
      "content-type": "application/json",
    },
  });

  if (!r.ok) return [];
  const data = (await r.json()) as VapiRow[];
  return Array.isArray(data) ? data : [];
}

function modeText(values: Array<string | null | undefined>) {
  const m = new Map<string, number>();
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [k, n] of m.entries()) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/* ---------------- Loader ---------------- */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await ensureSettings(shop);

  const fullSearch = safeSearch(request.url);
  const sp = new URLSearchParams(fullSearch.startsWith("?") ? fullSearch.slice(1) : fullSearch);

  const rangeParam = (sp.get("range") || "all").toLowerCase();
  const range: RangeKey = rangeParam === "7d" ? "7d" : rangeParam === "24h" ? "24h" : "all";
  const w = windowFromRange(range);

  const baseSearch = stripParam(fullSearch, "range");

  const settings = await db.settings.findFirst({
    where: { shop },
    select: {
      enabled: true,
      delayMinutes: true,
      maxAttempts: true,
      retryMinutes: true,
      minOrderValue: true,
      currency: true,
      callWindowStart: true,
      callWindowEnd: true,
      tone: true,
      goal: true,
      max_call_seconds: true,
      max_followup_questions: true,
      discount_enabled: true,
      max_discount_percent: true,
      offer_rule: true,
      min_cart_value_for_discount: true,
      coupon_prefix: true,
      coupon_validity_hours: true,
      free_shipping_enabled: true,
      followup_email_enabled: true,
      followup_sms_enabled: true,
      vapiAssistantId: true,
      vapiPhoneNumberId: true,
      userPrompt: true,
      merchantPrompt: true,
    },
  });

  const minOrderValue = Number(settings?.minOrderValue ?? 0);
  const currency = String(settings?.currency ?? "USD").toUpperCase();

  const checkoutWhereForLists =
    w.start != null
      ? {
          shop,
          ...checkoutTimeFilter(w.start, w.now),
        }
      : { shop };

  const callJobWhereForLists =
    w.start != null
      ? {
          shop,
          updatedAt: { gte: w.start, lt: w.now },
        }
      : { shop };

  const [recentCheckouts, recentCallJobs] = await Promise.all([
    db.checkout.findMany({
      where: checkoutWhereForLists as any,
      orderBy: [{ createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        shop: true,
        checkoutId: true,
        token: true,
        email: true,
        phone: true,
        value: true,
        currency: true,
        status: true,
        abandonedAt: true,
        createdAt: true,
        updatedAt: true,
        raw: true,
        customerName: true,
        itemsJson: true,
        recoveredAt: true,
        recoveredOrderId: true,
        recoveredAmount: true,
      },
    }),
    db.callJob.findMany({
      where: callJobWhereForLists as any,
      orderBy: [{ updatedAt: "desc" }],
      take: 250,
      select: {
        id: true,
        shop: true,
        checkoutId: true,
        phone: true,
        scheduledFor: true,
        status: true,
        attempts: true,
        provider: true,
        providerCallId: true,
        outcome: true,
        createdAt: true,
        updatedAt: true,
        endedReason: true,
        transcript: true,
        recordingUrl: true,
        sentiment: true,
        tagsCsv: true,
        reason: true,
        nextAction: true,
        followUp: true,
        analysisJson: true,
        attributedAt: true,
        attributedOrderId: true,
        attributedAmount: true,
      },
    }),
  ]);

  async function metricsForWindow(start: Date | null, end: Date) {
    const recoveredWhereBase: any = {
      shop,
      OR: [{ recoveredOrderId: { not: null } }, { recoveredAmount: { gt: 0 } }],
    };
    if (start) recoveredWhereBase.AND = [checkoutTimeFilter(start, end)];

    const recoveredCount = await db.checkout.count({ where: recoveredWhereBase });

    const recoveredAmountPos = await db.checkout.aggregate({
      where: {
        ...recoveredWhereBase,
        recoveredAmount: { gt: 0 },
      },
      _sum: { recoveredAmount: true },
    });

    // VERIFIED revenue only (conservative): do not fallback to cart value.
    const recoveredRevenue = Number(recoveredAmountPos._sum.recoveredAmount ?? 0);

    const abandonedEligibleWhere: any = {
      shop,
      status: "ABANDONED",
      value: { gte: minOrderValue },
      OR: [{ phone: { not: null } }, { email: { not: null } }],
    };
    if (start) abandonedEligibleWhere.AND = [checkoutTimeFilter(start, end)];

    const abandonedEligibleCount = await db.checkout.count({ where: abandonedEligibleWhere });
    const abandonedEligibleSum = await db.checkout.aggregate({
      where: abandonedEligibleWhere,
      _sum: { value: true },
    });
    const atRiskEligibleRevenue = Number(abandonedEligibleSum._sum.value ?? 0);

    const callCompletedWhere: any = { shop, status: "COMPLETED" };
    const callQueuedWhere: any = { shop, status: "QUEUED" };
    const callCallingWhere: any = { shop, status: "CALLING" };
    const callFailedWhere: any = { shop, status: "FAILED" };
    if (start) {
      callCompletedWhere.updatedAt = { gte: start, lt: end };
      callQueuedWhere.updatedAt = { gte: start, lt: end };
      callCallingWhere.updatedAt = { gte: start, lt: end };
      callFailedWhere.updatedAt = { gte: start, lt: end };
    }

    const [callsCompleted, callsQueued, callsCalling, callsFailed] = await Promise.all([
      db.callJob.count({ where: callCompletedWhere }),
      db.callJob.count({ where: callQueuedWhere }),
      db.callJob.count({ where: callCallingWhere }),
      db.callJob.count({ where: callFailedWhere }),
    ]);

    const winRate = pct(recoveredCount, recoveredCount + abandonedEligibleCount);

    return {
      recoveredCount,
      recoveredRevenue,
      abandonedEligibleCount,
      atRiskEligibleRevenue,
      winRate,
      callsCompleted,
      callsQueued,
      callsCalling,
      callsFailed,
    };
  }

  const currentMetrics = await metricsForWindow(w.start, w.now);
  const prevMetrics = w.prevStart && w.prevEnd ? await metricsForWindow(w.prevStart, w.prevEnd) : null;

  function supabaseRangeParams(start: Date | null) {
    const p = new URLSearchParams();
    p.set("shop", `eq.${shop}`);
    if (start) p.set("received_at", `gte.${start.toISOString()}`);
    return p;
  }

  async function followupCounts(start: Date | null) {
    const p = supabaseRangeParams(start);
    p.set("call_outcome", "eq.needs_followup");
    const vapiNeedsFollow = await supabaseCount(p);

    const cjWhere: any = { shop, outcome: "NEEDS_FOLLOWUP" };
    if (start) cjWhere.updatedAt = { gte: start, lt: w.now };
    const callJobNeedsFollow = await db.callJob.count({ where: cjWhere });

    return { vapiNeedsFollow, callJobNeedsFollow };
  }

  const followNow = await followupCounts(w.start);

  async function discountCount(start: Date | null) {
    const p = supabaseRangeParams(start);
    p.set("or", "(discount_suggest.eq.true,discount_percent.gt.0)");
    return supabaseCount(p);
  }

  const discountNow = await discountCount(w.start);

  const vapiSelect = [
    "received_at",
    "call_id",
    "checkout_id",
    "call_job_id",
    "answered",
    "voicemail",
    "sentiment",
    "call_outcome",
    "disposition",
    "buy_probability",
    "customer_intent",
    "objections_text",
    "next_best_action",
    "follow_up_message",
    "tags",
    "tagcsv",
    "discount_suggest",
    "discount_percent",
    "discount_rationale",
    "summary_clean",
    "transcript",
    "recording_url",
    "log_url",
    "ended_reason",
    "ai_status",
    "ai_error",
    "ai_processed_at",
    "ai_insights",
    "structured_outputs",
  ].join(",");

  const vapiRecentParams = new URLSearchParams();
  vapiRecentParams.set("select", vapiSelect);
  vapiRecentParams.set("shop", `eq.${shop}`);
  if (w.start) vapiRecentParams.set("received_at", `gte.${w.start.toISOString()}`);
  vapiRecentParams.set("order", "received_at.desc");
  vapiRecentParams.set("limit", "60");

  const vapiRecent = await supabaseFetchRows(vapiRecentParams);

  const blockersWindowStart = new Date(w.now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const totalCalls7d = await supabaseCount(
    (() => {
      const p = new URLSearchParams();
      p.set("shop", `eq.${shop}`);
      p.set("received_at", `gte.${blockersWindowStart.toISOString()}`);
      return p;
    })(),
  );

  const noAnswer7d = await supabaseCount(
    (() => {
      const p = new URLSearchParams();
      p.set("shop", `eq.${shop}`);
      p.set("received_at", `gte.${blockersWindowStart.toISOString()}`);
      p.set("or", "(answered.eq.false,call_outcome.eq.no_answer)");
      return p;
    })(),
  );

  const voicemail7d = await supabaseCount(
    (() => {
      const p = new URLSearchParams();
      p.set("shop", `eq.${shop}`);
      p.set("received_at", `gte.${blockersWindowStart.toISOString()}`);
      p.set("voicemail", "eq.true");
      return p;
    })(),
  );

  const needsFollow7d = await supabaseCount(
    (() => {
      const p = new URLSearchParams();
      p.set("shop", `eq.${shop}`);
      p.set("received_at", `gte.${blockersWindowStart.toISOString()}`);
      p.set("call_outcome", "eq.needs_followup");
      return p;
    })(),
  );

  const notInterested7d = await supabaseCount(
    (() => {
      const p = new URLSearchParams();
      p.set("shop", `eq.${shop}`);
      p.set("received_at", `gte.${blockersWindowStart.toISOString()}`);
      p.set("disposition", "eq.not_interested");
      return p;
    })(),
  );

  const verifiedRecoveredCheckoutIds = new Set(
    recentCheckouts.filter(isVerifiedRecoveredCheckoutRow).map((c) => String(c.checkoutId)),
  );

  const vapiNeedsFollowRows = vapiRecent.filter((r) => normLower(r.call_outcome) === "needs_followup");
  const vapiHighIntentRows = vapiRecent.filter((r) => {
    const buy = typeof r.buy_probability === "number" ? r.buy_probability : -1;
    const cid = String(r.checkout_id ?? "");
    if (!cid) return false;
    if (verifiedRecoveredCheckoutIds.has(cid)) return false;
    return buy >= 70;
  });
  const vapiDiscountRows = vapiRecent.filter((r) => Boolean(r.discount_suggest) || Number(r.discount_percent ?? 0) > 0);
  const vapiHumanRows = vapiRecent.filter((r) => {
    const err = String(r.ai_error ?? "").trim();
    const st = normLower(r.ai_status);
    return Boolean(err) || st.includes("error");
  });

  const vapiFailedRows = vapiRecent.filter((r) => {
    const outcome = normLower(r.call_outcome);
    const disp = normLower(r.disposition);
    const ended = String(r.ended_reason ?? "").trim();
    return outcome === "not_recovered" || disp === "not_interested" || Boolean(ended);
  });

  const followupsHeadlineDedup = (() => {
    const ids = new Set<string>();
    for (const r of vapiNeedsFollowRows) {
      const cid = String(r.checkout_id ?? "").trim();
      if (cid) ids.add(cid);
    }
    for (const j of recentCallJobs) {
      if (normUpper(j.outcome) === "NEEDS_FOLLOWUP") ids.add(String(j.checkoutId));
    }
    return ids.size;
  })();

  const discountDedup = (() => {
    const ids = new Set<string>();
    for (const r of vapiDiscountRows) {
      const cid = String(r.checkout_id ?? "").trim();
      if (cid) ids.add(cid);
    }
    return ids.size;
  })();

  const humanDedup = (() => {
    const ids = new Set<string>();
    for (const r of vapiHumanRows) {
      const cid = String(r.checkout_id ?? "").trim();
      if (cid) ids.add(cid);
    }
    return ids.size;
  })();

  const failedDedup = (() => {
    const ids = new Set<string>();
    for (const r of vapiFailedRows) {
      const cid = String(r.checkout_id ?? "").trim();
      if (cid) ids.add(cid);
    }
    for (const j of recentCallJobs) {
      const ended = String(j.endedReason ?? "").trim();
      if (normUpper(j.status) === "FAILED" || ended) ids.add(String(j.checkoutId));
    }
    return ids.size;
  })();

  const priorities: DashboardViewProps["priorities"] = [
    {
      key: "followups",
      label: "Send follow-ups",
      count: followupsHeadlineDedup,
      rawCountText: `vapi ${followNow.vapiNeedsFollow} + jobs ${followNow.callJobNeedsFollow}`,
      nextBestAction: modeText(vapiNeedsFollowRows.map((x) => x.next_best_action)),
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "followups"),
      tone: followupsHeadlineDedup > 0 ? "warning" : "new",
    },
    {
      key: "high_intent",
      label: "Work high-intent leads",
      count: vapiHighIntentRows.length,
      rawCountText: `buy_probability ≥ 70`,
      nextBestAction: modeText(vapiHighIntentRows.map((x) => x.next_best_action)),
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "high_intent"),
      tone: vapiHighIntentRows.length > 0 ? "info" : "new",
    },
    {
      key: "discounts",
      label: "Handle discount requests",
      count: discountDedup,
      rawCountText: `vapi ${discountNow}`,
      nextBestAction: modeText(vapiDiscountRows.map((x) => x.next_best_action)) || "Review discount rationale and reply with an offer.",
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "discounts"),
      tone: discountDedup > 0 ? "warning" : "new",
    },
    {
      key: "human",
      label: "Human intervention needed",
      count: humanDedup,
      rawCountText: `ai_error present`,
      nextBestAction: modeText(vapiHumanRows.map((x) => x.next_best_action)) || "Review AI error and reprocess the call summary.",
      href: appendParam(`/app/calls${baseSearch}`, "tab", "ai_errors"),
      tone: humanDedup > 0 ? "critical" : "new",
    },
    {
      key: "failed",
      label: "Review failed calls",
      count: failedDedup,
      rawCountText: `vapi + jobs`,
      nextBestAction: modeText(vapiFailedRows.map((x) => x.next_best_action)) || "Review objections and retry with updated script.",
      href: appendParam(`/app/calls${baseSearch}`, "tab", "failed"),
      tone: failedDedup > 0 ? "critical" : "new",
    },
    {
      key: "abandoned",
      label: "Work abandoned checkouts",
      count: currentMetrics.abandonedEligibleCount,
      rawCountText: `eligible (min ${fmtMoney(minOrderValue, currency)})`,
      nextBestAction: "Call contactable abandoned carts and send follow-up message if unanswered.",
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "abandoned"),
      tone: currentMetrics.abandonedEligibleCount > 0 ? "warning" : "new",
    },
  ];

  const recoveredForList = recentCheckouts
    .filter(isVerifiedRecoveredCheckoutRow)
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(String(a.recoveredAt ?? a.updatedAt ?? a.createdAt ?? ""));
      const tb = Date.parse(String(b.recoveredAt ?? b.updatedAt ?? b.createdAt ?? ""));
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    })
    .slice(0, 10)
    .map((c) => {
      const amt = Number(c.recoveredAmount ?? 0);
      const whenIso = c.recoveredAt
        ? new Date(c.recoveredAt).toISOString()
        : new Date(c.updatedAt ?? c.createdAt).toISOString();

      return {
        checkoutId: String(c.checkoutId),
        customerName: String(c.customerName ?? ""),
        amountText: fmtMoney(Math.max(0, amt), String(c.currency ?? currency)),
        whenText: minutesAgo(whenIso),
        recoveredOrderId: c.recoveredOrderId ? String(c.recoveredOrderId) : "—",
        href: appendParam(`/app/checkouts${baseSearch}`, "checkoutId", String(c.checkoutId)),
      };
    });

  const openCount = recentCheckouts.filter((c) => normUpper(c.status) === "OPEN").length;

  const pipeline: DashboardViewProps["pipelineRows"] = [
    {
      key: "open",
      label: "Open",
      count: openCount,
      tone: openCount > 0 ? "info" : "new",
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "open"),
    },
    {
      key: "abandonedEligible",
      label: "Abandoned eligible",
      count: currentMetrics.abandonedEligibleCount,
      tone: currentMetrics.abandonedEligibleCount > 0 ? "warning" : "new",
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "abandoned"),
    },
    {
      key: "queued",
      label: "Queued",
      count: currentMetrics.callsQueued,
      tone: currentMetrics.callsQueued > 0 ? "warning" : "new",
      href: appendParam(`/app/calls${baseSearch}`, "tab", "queued"),
    },
    {
      key: "calling",
      label: "Calling",
      count: currentMetrics.callsCalling,
      tone: currentMetrics.callsCalling > 0 ? "info" : "new",
      href: appendParam(`/app/calls${baseSearch}`, "tab", "calling"),
    },
    {
      key: "completed",
      label: "Completed",
      count: currentMetrics.callsCompleted,
      tone: currentMetrics.callsCompleted > 0 ? "info" : "new",
      href: appendParam(`/app/calls${baseSearch}`, "tab", "completed"),
    },
    {
      key: "recovered",
      label: "Recovered",
      count: currentMetrics.recoveredCount,
      tone: currentMetrics.recoveredCount > 0 ? "success" : "new",
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "recovered"),
    },
  ];

  type LiveInternal = DashboardViewProps["liveRows"][number] & { ts: number };

  const liveFromVapi: LiveInternal[] = vapiRecent.slice(0, 40).map((r) => {
    const iso = r.received_at ? new Date(r.received_at).toISOString() : "";
    const ts = iso ? Date.parse(iso) : 0;
    const cid = String(r.checkout_id ?? "").trim();

    const hasAiError = Boolean(String(r.ai_error ?? "").trim()) || normLower(r.ai_status).includes("error");
    const verified = cid ? verifiedRecoveredCheckoutIds.has(cid) : false;

    const outcome = normLower(r.call_outcome).trim();
    const answered = r.answered === true;
    const voicemail = r.voicemail === true;

    let status = "CALL";
    let tone: DashboardViewProps["liveRows"][number]["tone"] = "info";
    let statusHint = "Call outcome";

    if (hasAiError) {
      status = "AI_ERROR";
      tone = "critical";
      statusHint = "AI processing error";
    } else if (verified) {
      status = "ORDER_RECOVERED";
      tone = "success";
      statusHint = "Verified order";
    } else if (outcome === "needs_followup") {
      status = "NEEDS_FOLLOWUP";
      tone = "warning";
    } else if (outcome === "no_answer" || (!answered && outcome)) {
      status = "NO_ANSWER";
      tone = "warning";
    } else if (voicemail) {
      status = "VOICEMAIL";
      tone = "warning";
    } else if (outcome === "recovered") {
      // DO NOT present as recovered revenue/order
      status = "HIGH_INTENT";
      tone = "info";
      statusHint = "Call outcome (not a confirmed order)";
    } else if (outcome === "not_recovered") {
      status = "NOT_RECOVERED";
      tone = "new";
    } else if (outcome) {
      status = outcome.toUpperCase();
      tone = "info";
    }

    const event = `Call${cid ? ` • Checkout ${cid}` : ""}`;

    return {
      ts,
      key: `vapi:${String(r.call_id ?? "") || iso || Math.random().toString(16).slice(2)}`,
      event,
      status,
      tone,
      statusHint,
      whenText: iso ? minutesAgo(iso) : "—",
      recordingUrl: r.recording_url ? String(r.recording_url) : undefined,
      logUrl: r.log_url ? String(r.log_url) : undefined,
    };
  });

  const liveFromJobs: LiveInternal[] = recentCallJobs.slice(0, 40).map((j) => {
    const iso = new Date(j.updatedAt ?? j.createdAt).toISOString();
    const ts = Date.parse(iso);

    const st = normUpper(j.status);
    const out = String(j.outcome ?? "").trim();
    const outU = normUpper(out);
    const hasOutcomeError = outU.startsWith("ERROR:");
    const verified = Boolean(j.attributedOrderId) || Number(j.attributedAmount ?? 0) > 0;

    let status = st || "JOB";
    let tone: DashboardViewProps["liveRows"][number]["tone"] = "info";
    let statusHint = "Job status";

    if (hasOutcomeError) {
      status = "ERROR";
      tone = "critical";
      statusHint = "Provider/settings error";
    } else if (verified) {
      status = "ORDER_RECOVERED";
      tone = "success";
      statusHint = "Verified order";
    } else if (outU === "NEEDS_FOLLOWUP") {
      status = "NEEDS_FOLLOWUP";
      tone = "warning";
      statusHint = "Call outcome";
    } else if (st === "FAILED") {
      status = "FAILED";
      tone = "critical";
    } else if (st === "COMPLETED") {
      status = "COMPLETED";
      tone = "info";
      statusHint = "Completed call (not a confirmed order)";
    } else if (st === "QUEUED") {
      status = "QUEUED";
      tone = "warning";
    } else if (st === "CALLING") {
      status = "CALLING";
      tone = "info";
    } else {
      status = st || "JOB";
      tone = "info";
    }

    const event = `Job • Checkout ${String(j.checkoutId)}`;

    return {
      ts,
      key: `job:${String(j.id)}`,
      event,
      status,
      tone,
      statusHint,
      whenText: minutesAgo(iso),
      recordingUrl: j.recordingUrl ? String(j.recordingUrl) : undefined,
      logUrl: undefined,
    };
  });

  const liveActivity = [...liveFromVapi, ...liveFromJobs]
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 15)
    .map(({ ts, ...row }) => row);

  function deltaTextNumber(curr: number, prev: number) {
    const d = curr - prev;
    const sign = d > 0 ? "+" : d < 0 ? "−" : "";
    return `${sign}${Math.abs(d)}`;
  }

  function deltaTextMoney(curr: number, prev: number) {
    const d = curr - prev;
    const sign = d > 0 ? "+" : d < 0 ? "−" : "";
    return `${sign}${fmtMoney(Math.abs(d), currency)}`;
  }

  function metricTone(kind: string, value: number) {
    if (kind === "recovered") return value > 0 ? "success" : "info";
    if (kind === "win") return value >= 25 ? "success" : value >= 10 ? "warning" : "critical";
    if (kind === "atrisk") return value > 0 ? "warning" : "success";
    if (kind === "abandoned") return value > 0 ? "warning" : "success";
    if (kind === "followups") return value > 0 ? "warning" : "success";
    if (kind === "discounts") return value > 0 ? "warning" : "info";
    if (kind === "completed") return value > 0 ? "info" : "new";
    return "info";
  }

  const rangeLabel = range === "24h" ? "24h" : range === "7d" ? "7d" : "All-time";

  const metrics: DashboardViewProps["metrics"] = [
    {
      key: "recovered_revenue",
      label: "Recovered revenue (verified)",
      valueText: fmtMoney(currentMetrics.recoveredRevenue, currency),
      tone: metricTone("recovered", currentMetrics.recoveredRevenue),
      deltaText:
        prevMetrics && range !== "all"
          ? deltaTextMoney(currentMetrics.recoveredRevenue, prevMetrics.recoveredRevenue)
          : null,
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "recovered"),
    },
    {
      key: "at_risk_eligible_revenue",
      label: "Eligible at-risk revenue",
      valueText: fmtMoney(currentMetrics.atRiskEligibleRevenue, currency),
      tone: metricTone("atrisk", currentMetrics.atRiskEligibleRevenue),
      deltaText:
        prevMetrics && range !== "all"
          ? deltaTextMoney(currentMetrics.atRiskEligibleRevenue, prevMetrics.atRiskEligibleRevenue)
          : null,
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "abandoned"),
    },
    {
      key: "win_rate",
      label: "Win rate",
      valueText: `${currentMetrics.winRate}%`,
      tone: metricTone("win", currentMetrics.winRate),
      deltaText:
        prevMetrics && range !== "all" ? `${deltaTextNumber(currentMetrics.winRate, prevMetrics.winRate)} pts` : null,
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "recovered"),
    },
    {
      key: "abandoned_eligible_count",
      label: "Abandoned eligible",
      valueText: String(currentMetrics.abandonedEligibleCount),
      tone: metricTone("abandoned", currentMetrics.abandonedEligibleCount),
      deltaText:
        prevMetrics && range !== "all"
          ? deltaTextNumber(currentMetrics.abandonedEligibleCount, prevMetrics.abandonedEligibleCount)
          : null,
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "abandoned"),
    },
    {
      key: "calls_completed",
      label: "Calls completed",
      valueText: String(currentMetrics.callsCompleted),
      tone: metricTone("completed", currentMetrics.callsCompleted),
      deltaText:
        prevMetrics && range !== "all"
          ? deltaTextNumber(currentMetrics.callsCompleted, prevMetrics.callsCompleted)
          : null,
      href: appendParam(`/app/calls${baseSearch}`, "tab", "completed"),
    },
    {
      key: "followups_needed",
      label: "Follow-ups needed",
      valueText: String(followupsHeadlineDedup),
      tone: metricTone("followups", followupsHeadlineDedup),
      deltaText: null, // avoid misleading delta vs dedupe
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "followups"),
    },
    {
      key: "discount_requests",
      label: "Discount requests",
      valueText: String(discountDedup),
      tone: metricTone("discounts", discountDedup),
      deltaText: null, // avoid misleading delta vs dedupe
      href: appendParam(`/app/checkouts${baseSearch}`, "tab", "discounts"),
    },
  ];

  const hero =
    currentMetrics.recoveredRevenue > 0
      ? {
          show: true,
          recoveredRevenueText: fmtMoney(currentMetrics.recoveredRevenue, currency),
          recoveredCount: currentMetrics.recoveredCount,
          winRate: currentMetrics.winRate,
          href: appendParam(`/app/checkouts${baseSearch}`, "tab", "recovered"),
        }
      : { show: false as const };

  const blockersTotal = totalCalls7d;
  const blockers = [
    {
      key: "no_answer",
      label: "No answer",
      count: noAnswer7d,
      pct: blockersTotal ? pct(noAnswer7d, blockersTotal) : null,
      tone: noAnswer7d > 0 ? "warning" : "new",
    },
    {
      key: "voicemail",
      label: "Voicemail",
      count: voicemail7d,
      pct: blockersTotal ? pct(voicemail7d, blockersTotal) : null,
      tone: voicemail7d > 0 ? "warning" : "new",
    },
    {
      key: "needs_followup",
      label: "Needs follow-up",
      count: needsFollow7d,
      pct: blockersTotal ? pct(needsFollow7d, blockersTotal) : null,
      tone: needsFollow7d > 0 ? "warning" : "new",
    },
    {
      key: "not_interested",
      label: "Not interested",
      count: notInterested7d,
      pct: blockersTotal ? pct(notInterested7d, blockersTotal) : null,
      tone: notInterested7d > 0 ? "critical" : "new",
    },
  ];

  const vapiReady = Boolean(settings?.vapiAssistantId) && Boolean(settings?.vapiPhoneNumberId);
  const enabled = Boolean(settings?.enabled);
  const criticalMissing = enabled && !vapiReady;

  const settingsRows: DashboardViewProps["settings"]["rows"] = [
    { label: "Automation", value: enabled ? "Enabled" : "Disabled", tone: enabled ? "success" : "warning" },
    {
      label: "Call window",
      value: `${String(settings?.callWindowStart ?? "—")}–${String(settings?.callWindowEnd ?? "—")}`,
      tone: "info",
    },
    { label: "Delay", value: `${Number(settings?.delayMinutes ?? 0)} min`, tone: "info" },
    { label: "Retry", value: `${Number(settings?.retryMinutes ?? 0)} min`, tone: "info" },
    { label: "Max attempts", value: String(Number(settings?.maxAttempts ?? 0)), tone: "info" },
    { label: "Min order value", value: fmtMoney(minOrderValue, currency), tone: "info" },
    {
      label: "Discounts",
      value: settings?.discount_enabled ? `Enabled (max ${Number(settings?.max_discount_percent ?? 0)}%)` : "Disabled",
      tone: settings?.discount_enabled ? "warning" : "info",
    },
    {
      label: "Coupon",
      value: `${String(settings?.coupon_prefix ?? "—")} • ${Number(settings?.coupon_validity_hours ?? 0)}h`,
      tone: "info",
    },
    { label: "Free shipping", value: settings?.free_shipping_enabled ? "On" : "Off", tone: settings?.free_shipping_enabled ? "info" : "new" },
    { label: "Follow-up email", value: settings?.followup_email_enabled ? "On" : "Off", tone: settings?.followup_email_enabled ? "info" : "new" },
    { label: "Follow-up SMS", value: settings?.followup_sms_enabled ? "On" : "Off", tone: settings?.followup_sms_enabled ? "info" : "new" },
    { label: "Max call seconds", value: String(Number(settings?.max_call_seconds ?? 0)), tone: "info" },
    { label: "Max follow-up questions", value: String(Number(settings?.max_followup_questions ?? 0)), tone: "info" },
    { label: "Tone", value: String(settings?.tone ?? "—"), tone: "info" },
    { label: "Goal", value: String(settings?.goal ?? "—"), tone: "info" },
    { label: "Offer rule", value: String(settings?.offer_rule ?? "—"), tone: "info" },
    { label: "Min cart for discount", value: fmtMoney(Number(settings?.min_cart_value_for_discount ?? 0), currency), tone: "info" },
    { label: "Vapi assistant", value: settings?.vapiAssistantId ? "Set" : "Missing", tone: settings?.vapiAssistantId ? "success" : "critical" },
    { label: "Vapi phone number", value: settings?.vapiPhoneNumberId ? "Set" : "Missing", tone: settings?.vapiPhoneNumberId ? "success" : "critical" },
    { label: "Prompt", value: settings?.merchantPrompt || settings?.userPrompt ? "Configured" : "Missing", tone: settings?.merchantPrompt || settings?.userPrompt ? "success" : "warning" },
  ];

  const rangeLinks = {
    all: setParam(baseSearch || "?", "range", "all") || "?range=all",
    d7: setParam(baseSearch || "?", "range", "7d") || "?range=7d",
    h24: setParam(baseSearch || "?", "range", "24h") || "?range=24h",
  };

  const view: DashboardViewProps = {
    shopLabel: shop,
    nav: {
      checkoutsHref: `/app/checkouts${baseSearch}`,
      callsHref: `/app/calls${baseSearch}`,
    },
    range: { key: range, label: rangeLabel, links: rangeLinks },
    hero,
    metrics,
    pipelineRows: pipeline,
    liveRows: liveActivity,
    priorities,
    recentRecoveries: recoveredForList,
    blockers: {
      total: blockersTotal,
      rows: blockers,
    },
    settings: {
      criticalMissing,
      vapiReady,
      enabled,
      rows: settingsRows,
    },
    canCreateTestCall: true,
  };

  return { view };
};

export default function DashboardRoute() {
  const data = useLoaderData<typeof loader>();
  return <DashboardView {...data.view} />;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);