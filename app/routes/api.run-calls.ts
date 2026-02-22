// app/routes/api.run-calls.ts
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ensureSettings } from "../callRecovery.server";
import { startVapiCallForJob } from "../callProvider.server";

function parseHHMM(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function adjustToWindow(target: Date, startHHMM: string, endHHMM: string) {
  const start = parseHHMM(startHHMM) ?? 9 * 60;
  const end = parseHHMM(endHHMM) ?? 19 * 60;

  const windowStart = Math.min(start, end);
  const windowEnd = Math.max(start, end);

  const tMins = target.getHours() * 60 + target.getMinutes();
  if (tMins >= windowStart && tMins <= windowEnd) return target;

  const next = new Date(target);
  next.setSeconds(0, 0);
  next.setHours(Math.floor(windowStart / 60), windowStart % 60, 0, 0);

  if (tMins > windowEnd) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

// POST /api/run-calls
export async function action({ request }: ActionFunctionArgs) {
  const want = process.env.RUN_CALLS_SECRET || "";
  if (want) {
    const got = request.headers.get("x-run-calls-secret") || "";
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  const jobs = await db.callJob.findMany({
    where: {
      status: "QUEUED",
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: "asc" },
    take: 25,
  });

  let processed = 0;
  let started = 0;
  let failed = 0;

  for (const job of jobs) {
    // Lock exactly once and increment attempts exactly once here.
    const locked = await db.callJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: {
        status: "CALLING",
        attempts: { increment: 1 },
        outcome: null,
      },
    });

    if (locked.count === 0) continue;
    processed += 1;

    const settings = await ensureSettings(job.shop);
    const maxAttempts = Number((settings as any).maxAttempts ?? 1);

    try {
      const res = await startVapiCallForJob({
        shop: job.shop,
        callJobId: job.id,
      });

      // Keep status CALLING until webhook ends the call.
      await db.callJob.update({
        where: { id: job.id },
        data: {
          status: "CALLING",
          provider: "vapi",
          providerCallId: res.providerCallId ?? null,
          outcome: "VAPI_CALL_STARTED",
        },
      });

      started += 1;
    } catch (e: any) {
      const jobFresh = await db.callJob.findUnique({
        where: { id: job.id },
        select: { attempts: true },
      });
      const attemptsAfter = Number(jobFresh?.attempts ?? 0);

      if (attemptsAfter >= maxAttempts) {
        await db.callJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            outcome: `ERROR: ${String(e?.message ?? e)}`,
          },
        });
        failed += 1;
      } else {
        const retryMinutes = Number((settings as any).retryMinutes ?? 180);
        const nextTarget = new Date(Date.now() + retryMinutes * 60 * 1000);

        const startHHMM = String((settings as any).callWindowStart ?? "09:00");
        const endHHMM = String((settings as any).callWindowEnd ?? "19:00");

        const next = adjustToWindow(nextTarget, startHHMM, endHHMM);

        await db.callJob.update({
          where: { id: job.id },
          data: {
            status: "QUEUED",
            scheduledFor: next,
            outcome: `RETRY_SCHEDULED in ${retryMinutes}m`,
          },
        });
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      now: now.toISOString(),
      processed,
      started,
      failed,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}