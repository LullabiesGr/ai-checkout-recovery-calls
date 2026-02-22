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

  // ADDED: countryCodeV2/country so they land in checkout.raw (no new DB columns)
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

      // store raw-ish phone always (digits or +digits)
      const phoneStored = normalizePhoneForStorage(n?.phone);

      // IMPORTANT:
      // - Keep status ABANDONED (Shopify already considers it abandoned)
      // - Use abandonedAt = Shopify updatedAt/createdAt so delay can be enforced reliably
      const abandonedAt = completedAt ? null : new Date(n?.updatedAt ?? n?.createdAt ?? Date.now());

      await db.checkout.upsert({
        where: { shop_checkoutId: { shop, checkoutId } },
        create: {
          shop,
          checkoutId,
          token: null,
          email: n?.email ?? null,
          phone: phoneStored, // IMPORTANT: do not null out non-E.164 phones
          value: Number.isFinite(amount) ? amount : 0,
          currency,
          status: completedAt ? "CONVERTED" : "ABANDONED",
          abandonedAt,
          raw: JSON.stringify(n ?? null), // contains countryCodeV2 now
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
        promptMode: "append", // PromptMode enum value
      } as any,
    }))
  );
}

export async function markAbandonedByDelay(shop: string, delayMinutes: number) {
  const cutoff = new Date(Date.now() - delayMinutes * 60 * 1000);

  // Use updatedAt so “last activity” drives abandonment timing.
  // Also avoid re-updating abandonedAt repeatedly.
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
 * ENQUEUE (FAST + IMMEDIATE)
 *
 * - Creates CallJob immediately (so UI shows it right away), even if scheduledFor is in the future.
 * - scheduledFor still respects: abandonedAt + delayMinutes and call window.
 * - Prevents duplicates by skipping if any QUEUED/CALLING exists for that checkout.
 * - Avoids N+1: does a single batch query for all CallJobs for candidate checkoutIds.
 *
 * NOTE: If you only run this via cron, the fastest it can appear is the next cron tick.
 * For true instant enqueue, call enqueueCallJobs() from the checkout webhook route too.
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
  const { shop, enabled, minOrderValue, callWindowStart, callWindowEnd, delayMinutes, maxAttempts, retryMinutes } =
    params;

  if (!enabled) return { enqueued: 0 };

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

  if (!candidates.length) return { enqueued: 0 };

  const checkoutIds = candidates.map((c) => c.checkoutId);

  // Batch query all existing jobs for these checkouts (single query).
  const existingJobs = await db.callJob.findMany({
    where: {
      shop,
      checkoutId: { in: checkoutIds },
    },
    select: {
      checkoutId: true,
      status: true,
      createdAt: true,
      scheduledFor: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const totalCount = new Map<string, number>();
  const hasInFlight = new Set<string>();
  const lastJob = new Map<string, { status: string; createdAt: Date; scheduledFor: Date | null }>();

  for (const j of existingJobs) {
    totalCount.set(j.checkoutId, (totalCount.get(j.checkoutId) ?? 0) + 1);

    if (j.status === "QUEUED" || j.status === "CALLING") {
      hasInFlight.add(j.checkoutId);
    }

    // Because we ordered by createdAt desc, first job per checkout is latest.
    if (!lastJob.has(j.checkoutId)) {
      lastJob.set(j.checkoutId, {
        status: String(j.status),
        createdAt: new Date(j.createdAt),
        scheduledFor: (j as any).scheduledFor ? new Date((j as any).scheduledFor) : null,
      });
    }
  }

  let enqueued = 0;

  for (const c of candidates) {
    const phone = String((c as any).phone || "").trim();
    if (!phone) continue;

    if (hasInFlight.has(c.checkoutId)) continue;

    const total = totalCount.get(c.checkoutId) ?? 0;
    if (total >= maxA) continue;

    const last = lastJob.get(c.checkoutId) ?? null;

    // Compute next target time from SETTINGS minutes (not cron tick time)
    let target: Date;

    if (!last) {
      const base = new Date(c.abandonedAt as any);
      target = new Date(base.getTime() + delayM * 60 * 1000);
    } else {
      // Next attempt only after terminal status
      if (last.status !== "FAILED" && last.status !== "COMPLETED") continue;

      const anchor = new Date((last.scheduledFor ?? last.createdAt) as any);
      target = new Date(anchor.getTime() + retryM * 60 * 1000);
    }

    const scheduledFor = adjustToWindow(target, callWindowStart, callWindowEnd);

    try {
      await db.callJob.create({
        data: {
          shop,
          checkoutId: c.checkoutId,
          phone, // can be digits or +digits; provider will normalize using checkout.raw country
          scheduledFor,
          status: "QUEUED",
          attempts: 0,
        },
      });

      // Update local caches so we don't enqueue twice in the same run
      hasInFlight.add(c.checkoutId);
      totalCount.set(c.checkoutId, total + 1);
      lastJob.set(c.checkoutId, { status: "QUEUED", createdAt: new Date(), scheduledFor });

      enqueued += 1;
    } catch (e: any) {
      const msg = String(e?.message ?? "").toLowerCase();
      if (msg.includes("unique")) continue;
      throw e;
    }
  }

  return { enqueued };
}