// app/callRecovery.server.ts
import db from "./db.server";

type AdminClient = {
  graphql: (query: string, options?: any) => Promise<any>;
};

function parseHHMM(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function clamp(n: number, min: number, max: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/**
 * Store phone as:
 * - "+<digits>" if international prefix is provided (E.164-ish)
 * - "<digits>" if local/national number is provided (no country)
 *
 * Provider will later convert to real E.164 using country inferred from checkout.raw.
 */
function normalizePhoneForStorage(raw: any): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let s = input.replace(/^tel:/i, "").trim();

  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("011")) s = "+" + s.slice(3);

  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;

  return hasPlus ? `+${digits}` : digits;
}

/**
 * If target is inside window -> keep.
 * Else move to next window start (same day or next day).
 */
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

  // If target is after today's end, schedule next day start
  if (tMins > windowEnd) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

export async function syncAbandonedCheckoutsFromShopify(params: {
  admin: AdminClient;
  shop: string;
  limit?: number;
}) {
  const { admin, shop } = params;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

  const query = `
    query AbandonedCheckouts($first: Int!) {
      abandonedCheckouts(first: $first) {
        edges {
          node {
            id
            abandonedCheckoutUrl
            createdAt
            updatedAt
            completedAt
            email
            phone
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
            shippingAddress {
              firstName
              lastName
              countryCodeV2
              country
            }
            billingAddress {
              countryCodeV2
              country
            }
            customer {
              firstName
              lastName
              defaultAddress {
                countryCodeV2
                country
              }
            }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                  variantTitle
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await admin.graphql(query, { variables: { first: limit } });
    const json = typeof (res as any)?.json === "function" ? await (res as any).json() : res;
    const edges = json?.data?.abandonedCheckouts?.edges ?? [];
    if (!Array.isArray(edges)) return { synced: 0 };

    let synced = 0;

    for (const e of edges) {
      const n = e?.node;
      const checkoutId = String(n?.id ?? "").trim();
      if (!checkoutId) continue;

      const firstName = String(n?.shippingAddress?.firstName ?? n?.customer?.firstName ?? "").trim();
      const lastName = String(n?.shippingAddress?.lastName ?? n?.customer?.lastName ?? "").trim();
      const customerName = `${firstName} ${lastName}`.trim() || null;

      const items = (n?.lineItems?.edges ?? [])
        .map((x: any) => x?.node)
        .filter(Boolean)
        .map((it: any) => ({
          title: it?.title ?? null,
          quantity: Number(it?.quantity ?? 1),
          variantTitle: it?.variantTitle ?? null,
          price: it?.originalUnitPriceSet?.shopMoney?.amount ?? null,
          currency: it?.originalUnitPriceSet?.shopMoney?.currencyCode ?? null,
        }))
        .filter((x: any) => x.title);

      const itemsJson = items.length ? JSON.stringify(items) : null;

      const amount = Number(n?.totalPriceSet?.shopMoney?.amount ?? 0);
      const currency = String(n?.totalPriceSet?.shopMoney?.currencyCode ?? "USD");
      const completedAt = n?.completedAt ? new Date(n.completedAt) : null;
      const phoneStored = normalizePhoneForStorage(n?.phone);

      const abandonedAt = completedAt ? null : new Date(n?.updatedAt ?? n?.createdAt ?? Date.now());

      await db.checkout.upsert({
        where: { shop_checkoutId: { shop, checkoutId } },
        create: {
          shop,
          checkoutId,
          token: null,
          email: n?.email ?? null,
          phone: phoneStored,
          value: Number.isFinite(amount) ? amount : 0,
          currency,
          status: completedAt ? "CONVERTED" : "ABANDONED",
          abandonedAt,
          raw: JSON.stringify(n ?? null),
          customerName,
          itemsJson,
        },
        update: {
          email: n?.email ?? null,
          phone: phoneStored,
          value: Number.isFinite(amount) ? amount : 0,
          currency,
          status: completedAt ? "CONVERTED" : "ABANDONED",
          abandonedAt,
          raw: JSON.stringify(n ?? null),
          customerName,
          itemsJson,
        },
      });

      synced += 1;
    }

    return { synced };
  } catch {
    return { synced: 0 };
  }
}

export async function ensureSettings(shop: string) {
  return (
    (await db.settings.findUnique({ where: { shop } })) ??
    (await db.settings.create({
      data: {
        shop,
        enabled: true,
        delayMinutes: 30,
        maxAttempts: 2,
        retryMinutes: 180,
        minOrderValue: 0,
        currency: "USD",
        callWindowStart: "09:00",
        callWindowEnd: "19:00",
        vapiAssistantId: null,
        vapiPhoneNumberId: null,
        userPrompt: "",
        merchantPrompt: "",
        promptMode: "replace",
      } as any,
    }))
  );
}

export async function markAbandonedByDelay(shop: string, delayMinutes: number) {
  const cutoff = new Date(Date.now() - delayMinutes * 60 * 1000);

  return db.checkout.updateMany({
    where: {
      shop,
      status: "OPEN",
      updatedAt: { lte: cutoff },
      abandonedAt: null,
    },
    data: {
      status: "ABANDONED",
      abandonedAt: new Date(),
    },
  });
}

/**
 * ENQUEUE
 *
 * Notes:
 * - maxAttempts is enforced per current abandonment cycle.
 * - Abandonment cycle is driven by Checkout.abandonedAt (set by markAbandonedByDelay).
 * - When a checkout becomes active again, webhook should set status=OPEN + abandonedAt=null to start a new cycle.
 */
export async function enqueueCallJobs(params: {
  shop: string;
  enabled: boolean;
  minOrderValue: number;
  callWindowStart: string;
  callWindowEnd: string;
  delayMinutes: number;
  maxAttempts: number;
  retryMinutes: number;
}) {
  const { shop, enabled, minOrderValue, callWindowStart, callWindowEnd, delayMinutes, maxAttempts, retryMinutes } =
    params;

  if (!enabled) {
    console.log("[ENQUEUE] disabled", { shop });
    return { enqueued: 0 };
  }

  const now = new Date();
  const nowMs = now.getTime();

  const minValue = Number(minOrderValue ?? 0);
  const delayM = Math.max(0, Number(delayMinutes ?? 30));
  const retryM = Math.max(0, Number(retryMinutes ?? 180));
  const maxA = clamp(Number(maxAttempts ?? 2), 1, 10);

  // Stale protection to avoid permanent IN_FLIGHT_EXISTS
  const CALLING_STALE_MINUTES = clamp(Number(process.env.CALLING_STALE_MINUTES ?? 30), 5, 240);
  const QUEUED_STALE_HOURS = clamp(Number(process.env.QUEUED_STALE_HOURS ?? 24), 1, 168);

  const candidates = await db.checkout.findMany({
    where: {
      shop,
      status: "ABANDONED",
      phone: { not: null },
      value: { gte: minValue },
      abandonedAt: { not: null },
    },
    select: { checkoutId: true, phone: true, abandonedAt: true, updatedAt: true, value: true },
    take: 200,
  });

  if (!candidates.length) {
    console.log("[ENQUEUE] no_candidates", { shop, minValue });
    return { enqueued: 0 };
  }

  const checkoutIds = candidates.map((c) => c.checkoutId);

  const existingJobs = await db.callJob.findMany({
    where: {
      shop,
      checkoutId: { in: checkoutIds },
    },
    select: {
      id: true,
      checkoutId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      scheduledFor: true,
      providerCallId: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const jobsByCheckout = new Map<
    string,
    Array<{
      id: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      scheduledFor: Date | null;
      providerCallId: string | null;
    }>
  >();

  for (const j of existingJobs) {
    const arr = jobsByCheckout.get(j.checkoutId) ?? [];
    arr.push({
      id: String(j.id),
      status: String(j.status),
      createdAt: new Date(j.createdAt),
      updatedAt: new Date((j as any).updatedAt ?? j.createdAt),
      scheduledFor: (j as any).scheduledFor ? new Date((j as any).scheduledFor) : null,
      providerCallId: (j as any).providerCallId ? String((j as any).providerCallId) : null,
    });
    jobsByCheckout.set(j.checkoutId, arr);
  }

  console.log("[ENQUEUE] candidates", {
    shop,
    count: candidates.length,
    candidates: candidates.map((c) => ({
      checkoutId: c.checkoutId,
      abandonedAt: c.abandonedAt,
      updatedAt: c.updatedAt,
      hasPhone: Boolean(String((c as any).phone ?? "").trim()),
      value: Number(c.value ?? 0),
    })),
  });

  let enqueued = 0;

  for (const c of candidates) {
    const phone = String((c as any).phone || "").trim();
    const cycleStart = new Date((c.abandonedAt as any) ?? (c.updatedAt as any) ?? Date.now());

    if (!phone) {
      console.log("[ENQUEUE] skip", { shop, checkoutId: c.checkoutId, reason: "NO_PHONE" });
      continue;
    }

    const allJobs = jobsByCheckout.get(c.checkoutId) ?? [];
    const cycleJobs = allJobs.filter((j) => new Date(j.createdAt).getTime() >= cycleStart.getTime());

    // Auto-expire stale CALLING/QUEUED so they don't block forever.
    for (const j of cycleJobs) {
      const ageMs = nowMs - j.createdAt.getTime();

      if (j.status === "CALLING" && ageMs > CALLING_STALE_MINUTES * 60 * 1000) {
        try {
          await db.callJob.update({
            where: { id: j.id },
            data: {
              status: "FAILED",
              outcome: `STALE_CALLING_TIMEOUT_${CALLING_STALE_MINUTES}M`,
              updatedAt: new Date(),
            } as any,
          });
          j.status = "FAILED";
        } catch (e: any) {
          console.log("[ENQUEUE] stale_calling_update_failed", { shop, checkoutId: c.checkoutId, id: j.id, err: String(e?.message ?? e) });
        }
      }

      if (j.status === "QUEUED") {
        const dueAt = j.scheduledFor ? j.scheduledFor.getTime() : j.createdAt.getTime();
        const overdueMs = nowMs - dueAt;
        if (overdueMs > QUEUED_STALE_HOURS * 60 * 60 * 1000) {
          try {
            await db.callJob.update({
              where: { id: j.id },
              data: {
                status: "FAILED",
                outcome: `STALE_QUEUED_TIMEOUT_${QUEUED_STALE_HOURS}H`,
                updatedAt: new Date(),
              } as any,
            });
            j.status = "FAILED";
          } catch (e: any) {
            console.log("[ENQUEUE] stale_queued_update_failed", { shop, checkoutId: c.checkoutId, id: j.id, err: String(e?.message ?? e) });
          }
        }
      }
    }

    const inFlight = cycleJobs.some((j) => j.status === "QUEUED" || j.status === "CALLING");
    if (inFlight) {
      console.log("[ENQUEUE] skip", { shop, checkoutId: c.checkoutId, reason: "IN_FLIGHT_EXISTS" });
      continue;
    }

    const cycleAttempts = cycleJobs.length;
    if (cycleAttempts >= maxA) {
      console.log("[ENQUEUE] skip", {
        shop,
        checkoutId: c.checkoutId,
        reason: "MAX_ATTEMPTS_REACHED_FOR_CURRENT_CYCLE",
        cycleAttempts,
        maxA,
        cycleStart: cycleStart.toISOString(),
      });
      continue;
    }

    const lastCycleJob = cycleJobs[0] ?? null;
    let target: Date;

    if (!lastCycleJob) {
      target = new Date(cycleStart.getTime() + delayM * 60 * 1000);
    } else {
      if (lastCycleJob.status !== "FAILED" && lastCycleJob.status !== "COMPLETED" && lastCycleJob.status !== "CANCELED") {
        console.log("[ENQUEUE] skip", {
          shop,
          checkoutId: c.checkoutId,
          reason: "LAST_JOB_NOT_TERMINAL",
          lastStatus: lastCycleJob.status,
        });
        continue;
      }

      const anchor = new Date((lastCycleJob.scheduledFor ?? lastCycleJob.createdAt) as any);
      target = new Date(anchor.getTime() + retryM * 60 * 1000);
    }

    const scheduledFor = adjustToWindow(target, callWindowStart, callWindowEnd);

    try {
      const created = await db.callJob.create({
        data: {
          shop,
          checkoutId: c.checkoutId,
          phone,
          scheduledFor,
          status: "QUEUED",
          attempts: 0,
        },
      });

      const arr = jobsByCheckout.get(c.checkoutId) ?? [];
      arr.unshift({
        id: created.id,
        status: "QUEUED",
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduledFor,
        providerCallId: null,
      });
      jobsByCheckout.set(c.checkoutId, arr);

      enqueued += 1;

      console.log("[ENQUEUE] created", {
        id: created.id,
        shop,
        checkoutId: c.checkoutId,
        scheduledFor: scheduledFor.toISOString(),
        cycleStart: cycleStart.toISOString(),
      });
    } catch (e: any) {
      const msg = String(e?.message ?? "").toLowerCase();
      if (msg.includes("unique")) {
        console.log("[ENQUEUE] skip", { shop, checkoutId: c.checkoutId, reason: "UNIQUE_CONSTRAINT" });
        continue;
      }
      console.log("[ENQUEUE] error", {
        shop,
        checkoutId: c.checkoutId,
        error: String(e?.message ?? e),
      });
      throw e;
    }
  }

  return { enqueued };
}