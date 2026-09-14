import { processPrivacyQueue } from "../lib/privacy.server";
// app/routes/api.cron.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ensureSettings, markAbandonedByDelay, enqueueCallJobs } from "../callRecovery.server";

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function action({ request }: ActionFunctionArgs) {
  const want = process.env.CRON_TOKEN || "";
  if (!want) return new Response("Service not configured", { status: 503 });
  if (want) {
    const got = request.headers.get("x-cron-token") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  // Privacy work must never block checkout recovery for every merchant.
  let privacyError: string | null = null;
  try {
    await processPrivacyQueue();
  } catch (error) {
    privacyError = errorMessage(error);
    console.error("[CRON] privacy_error", { error: privacyError });
  }

  const serverNow = new Date();

  const settingsShops = (await db.settings.findMany({ select: { shop: true } })).map((x) => x.shop);
  const checkoutShops = (await db.checkout.findMany({ select: { shop: true }, distinct: ["shop"] })).map((x) => x.shop);
  const shops = Array.from(new Set([...settingsShops, ...checkoutShops].filter(Boolean)));

  console.log("[CRON] shops", shops);

  let markedTotal = 0;
  let enqueuedTotal = 0;

  const queuedDueBefore = await db.callJob.count({
    where: { status: "QUEUED", scheduledFor: { lte: serverNow } },
  });

  const perShop: Array<{
    shop: string;
    enabled: boolean | null;
    delayMinutes: number | null;
    retryMinutes: number | null;
    maxAttempts: number | null;
    marked: number;
    enqueued: number;
    error: string | null;
  }> = [];

  // Every shop is isolated. One broken merchant must not block the others.
  for (const shop of shops) {
    let enabled: boolean | null = null;
    let delayMinutes: number | null = null;
    let retryMinutes: number | null = null;
    let maxAttempts: number | null = null;
    let marked = 0;
    let enqueued = 0;

    try {
      const settings = await ensureSettings(shop);

      enabled = Boolean(settings.enabled);
      delayMinutes = Number(settings.delayMinutes ?? 30);
      retryMinutes = Number(settings.retryMinutes ?? 180);
      maxAttempts = Number(settings.maxAttempts ?? 2);

      console.log("[CRON] shop", {
        shop,
        enabled,
        delayMinutes,
        retryMinutes,
        maxAttempts,
        minOrderValue: Number(settings.minOrderValue ?? 0),
        callWindowStart: String((settings as any).callWindowStart ?? "09:00"),
        callWindowEnd: String((settings as any).callWindowEnd ?? "19:00"),
      });

      const markedRes = await markAbandonedByDelay(shop, delayMinutes);
      marked = Number((markedRes as any)?.count ?? 0);
      markedTotal += marked;

      const enq = await enqueueCallJobs({
        shop,
        enabled,
        minOrderValue: Number(settings.minOrderValue ?? 0),
        callWindowStart: String((settings as any).callWindowStart ?? "09:00"),
        callWindowEnd: String((settings as any).callWindowEnd ?? "19:00"),
        delayMinutes,
        maxAttempts,
        retryMinutes,
      } as any);

      enqueued = Number((enq as any)?.enqueued ?? 0);
      enqueuedTotal += enqueued;

      console.log("[CRON] result", { shop, marked, enqueued });

      perShop.push({
        shop,
        enabled,
        delayMinutes,
        retryMinutes,
        maxAttempts,
        marked,
        enqueued,
        error: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      console.error("[CRON] shop_error", { shop, error: message });
      perShop.push({
        shop,
        enabled,
        delayMinutes,
        retryMinutes,
        maxAttempts,
        marked,
        enqueued,
        error: message,
      });
    }
  }

  const nowAfter = new Date();
  const queuedDueAfter = await db.callJob.count({
    where: { status: "QUEUED", scheduledFor: { lte: nowAfter } },
  });

  let runCallsStatus: number | null = null;
  let runCallsBody: any = null;
  let runCallsError: string | null = null;

  const appUrl = String(process.env.APP_URL || "").replace(/\/$/, "");
  if (!appUrl) {
    runCallsError = "Missing APP_URL env";
    runCallsBody = { error: runCallsError };
  } else {
    try {
      const res = await fetch(`${appUrl}/api/run-calls`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-run-calls-secret": process.env.RUN_CALLS_SECRET || "",
        },
        body: JSON.stringify({ source: "cron", at: new Date().toISOString() }),
      });

      runCallsStatus = res.status;

      const text = await res.text().catch(() => "");
      try {
        runCallsBody = text ? JSON.parse(text) : null;
      } catch {
        runCallsBody = { raw: text };
      }

      if (!res.ok) {
        runCallsError = `Run-calls returned HTTP ${res.status}`;
        console.error("[CRON] run_calls_error", { status: res.status, body: runCallsBody });
      }
    } catch (error) {
      runCallsError = errorMessage(error);
      runCallsBody = { error: runCallsError };
      console.error("[CRON] run_calls_error", { error: runCallsError });
    }
  }

  const hadErrors =
    Boolean(privacyError) ||
    perShop.some((item) => Boolean(item.error)) ||
    Boolean(runCallsError);

  const body = {
    ok: !hadErrors,
    partial: hadErrors,
    shops: shops.length,
    perShop,
    privacyError,
    markedTotal,
    enqueuedTotal,
    queuedDueBefore,
    queuedDueAfter,
    runCallsStatus,
    runCallsBody,
    runCallsError,
    serverNow: new Date().toISOString(),
  };

  console.log("[CRON] summary", body);

  // Partial subsystem/store failures are reported in JSON but do not return 500,
  // so one merchant or privacy task can never stop recovery for every shop.
  return json(body);
}
