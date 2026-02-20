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

export async function action({ request }: ActionFunctionArgs) {
  // Auth (Supabase Scheduler -> Render)
  const want = process.env.CRON_TOKEN || "";
  if (want) {
    const got = request.headers.get("x-cron-token") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  const serverNow = new Date();

  // Shops
  const shops = (await db.settings.findMany({ select: { shop: true } })).map((x) => x.shop);

  let markedTotal = 0;
  let enqueuedTotal = 0;

  // Snapshot before
  const queuedDueBefore = await db.callJob.count({
    where: { status: "QUEUED", scheduledFor: { lte: serverNow } },
  });

  const perShop: Array<{
    shop: string;
    enabled: boolean;
    delayMinutes: number;
    retryMinutes: number;
    maxAttempts: number;
    marked: number;
    enqueued: number;
  }> = [];

  for (const shop of shops) {
    const settings = await ensureSettings(shop);

    // NOTE:
    // delayMinutes is used both as:
    // - legacy markAbandonedByDelay cutoff (OPEN -> ABANDONED)
    // - first call timing (handled inside enqueueCallJobs using Settings.delayMinutes)
    const delayMinutes = Number(settings.delayMinutes ?? 30);
    const retryMinutes = Number(settings.retryMinutes ?? 180);
    const maxAttempts = Number(settings.maxAttempts ?? 2);

    const markedRes = await markAbandonedByDelay(shop, delayMinutes);
    const marked = Number((markedRes as any)?.count ?? 0);
    markedTotal += marked;

    const enq = await enqueueCallJobs({
      shop,
      enabled: Boolean(settings.enabled),
      minOrderValue: Number(settings.minOrderValue ?? 0),
      callWindowStart: String((settings as any).callWindowStart ?? "09:00"),
      callWindowEnd: String((settings as any).callWindowEnd ?? "19:00"),

      // IMPORTANT:
      // These minutes come from Settings table and MUST drive spacing:
      // - first attempt scheduled at abandonedAt + delayMinutes
      // - next attempt scheduled at lastAttemptAt + retryMinutes
      delayMinutes,
      maxAttempts,
      retryMinutes,
    } as any);

    const enqueued = Number((enq as any)?.enqueued ?? 0);
    enqueuedTotal += enqueued;

    perShop.push({
      shop,
      enabled: Boolean(settings.enabled),
      delayMinutes,
      retryMinutes,
      maxAttempts,
      marked,
      enqueued,
    });
  }

  // Snapshot after
  const nowAfter = new Date();
  const queuedDueAfter = await db.callJob.count({
    where: { status: "QUEUED", scheduledFor: { lte: nowAfter } },
  });

  // Kick dialer (safe + idempotent because /api/run-calls locks jobs)
  let runCallsStatus: number | null = null;
  let runCallsBody: any = null;

  const appUrl = String(process.env.APP_URL || "").replace(/\/$/, "");
  if (!appUrl) {
    runCallsBody = { error: "Missing APP_URL env" };
  } else {
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
  }

  return json({
    ok: true,
    shops: shops.length,
    perShop,
    markedTotal,
    enqueuedTotal,
    queuedDueBefore,
    queuedDueAfter,
    runCallsStatus,
    runCallsBody,
    serverNow: new Date().toISOString(),
  });
}