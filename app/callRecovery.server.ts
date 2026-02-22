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

  // if target time is after today's end OR after start (but outside window), schedule next day window start
  if (tMins > windowEnd || tMins > windowStart) {
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
            shippingAddress { firstName lastName }
            customer { firstName lastName }
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

      // IMPORTANT:
      // - Keep status ABANDONED (Shopify already considers it abandoned),
      // - Use abandonedAt = Shopify updatedAt/createdAt so delay can be enforced reliably.
      const abandonedAt = completedAt ? null : new Date(n?.updatedAt ?? n?.createdAt ?? Date.now());

      await db.checkout.upsert({
        where: { shop_checkoutId: { shop, checkoutId } },
        create: {
          shop,
          checkoutId,
          token: null,
          email: n?.email ?? null,
          phone: n?.phone ?? null,
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
          phone: n?.phone ?? null,
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
        promptMode: "append", // ✅ NEW DEFAULT
      } as any,
    }))
  );
}

export async function markAbandonedByDelay(shop: string, delayMinutes: number) {
  // Legacy path (kept). Your pipeline uses status=ABANDONED directly from sync,
  // so this typically does nothing, but it’s harmless.
  const cutoff = new Date(Date.now() - delayMinutes * 60 * 1000);

  return db.checkout.updateMany({
    where: {
      shop,
      status: "OPEN",
      createdAt: { lte: cutoff },
    },
    data: {
      status: "ABANDONED",
      abandonedAt: new Date(),
    },
  });
}

/**
 * Enqueue logic (uses minutes from Settings):
 * - 1st call time is based on abandonedAt + delayMinutes (NOT "now")
 * - Next call is based on last attempt + retryMinutes
 * - Stops at maxAttempts
 *
 * Also prevents spam by not enqueueing if the computed target time is still in the future.
 */
export async function enqueueCallJobs(params: {
  shop: string;
  enabled: boolean;
  minOrderValue: number;
  callWindowStart: string;
  callWindowEnd: string;
  delayMinutes: number;
  maxAttempts: number; // per-checkout cap
  retryMinutes: number; // spacing between attempts
}) {
  const {
    shop,
    enabled,
    minOrderValue,
    callWindowStart,
    callWindowEnd,
    delayMinutes,
    maxAttempts,
    retryMinutes,
  } = params;

  if (!enabled) return { enqueued: 0 };

  const now = new Date();

  const minValue = Number(minOrderValue ?? 0);
  const delayM = Math.max(0, Number(delayMinutes ?? 30));
  const retryM = Math.max(0, Number(retryMinutes ?? 180));
  const maxA = clamp(Number(maxAttempts ?? 2), 1, 10);

  // Candidates must be ABANDONED with phone and abandonedAt set.
  const candidates = await db.checkout.findMany({
    where: {
      shop,
      status: "ABANDONED",
      phone: { not: null },
      value: { gte: minValue },
      abandonedAt: { not: null },
    },
    select: { checkoutId: true, phone: true, abandonedAt: true },
    take: 200,
  });

  let enqueued = 0;

  for (const c of candidates) {
    const phone = String(c.phone || "").trim();
    if (!phone) continue;

    // If there is already a queued/calling job, never create another.
    const inFlight = await db.callJob.findFirst({
      where: {
        shop,
        checkoutId: c.checkoutId,
        status: { in: ["QUEUED", "CALLING"] },
      },
      select: { id: true },
    });
    if (inFlight) continue;

    // Cap total call jobs per checkout
    const totalForCheckout = await db.callJob.count({
      where: { shop, checkoutId: c.checkoutId },
    });
    if (totalForCheckout >= maxA) continue;

    // Last job (to compute the next allowed time)
    const last = await db.callJob.findFirst({
      where: { shop, checkoutId: c.checkoutId },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true, scheduledFor: true },
    });

    // Compute target time from SETTINGS minutes (not from cron tick time)
    let target: Date;

    if (!last) {
      // 1st attempt: abandonedAt + delayMinutes
      const base = new Date(c.abandonedAt as any);
      target = new Date(base.getTime() + delayM * 60 * 1000);
    } else {
      // Next attempt only after terminal status
      if (last.status !== "FAILED" && last.status !== "COMPLETED") continue;

      // Anchor on last scheduledFor (preferred) or createdAt
      const anchor = new Date((last as any).scheduledFor ?? last.createdAt);
      target = new Date(anchor.getTime() + retryM * 60 * 1000);
    }

    // Not due yet -> do not enqueue now (prevents “spam inserts every cron tick”)
    if (target > now) continue;

    // Respect call window; if outside, move to next window start
    const scheduledFor = adjustToWindow(target, callWindowStart, callWindowEnd);

    try {
      await db.callJob.create({
        data: {
          shop,
          checkoutId: c.checkoutId,
          phone,
          scheduledFor,
          status: "QUEUED",
          attempts: 0,
        },
      });

      enqueued += 1;
    } catch (e: any) {
      // If you add a DB unique partial index (recommended), ignore unique conflicts here.
      const msg = String(e?.message ?? "").toLowerCase();
      if (msg.includes("unique")) continue;
      throw e;
    }
  }

  return { enqueued };
}