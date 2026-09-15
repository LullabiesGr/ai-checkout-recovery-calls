import db from "../db.server";

export function attemptLimit(value: unknown) {
  const n = Number(value ?? 2);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.floor(n))) : 2;
}

// Every dispatcher uses this transaction. Lock the cart, not just an individual
// job, so concurrent workers cannot each consume the last available attempt.
export async function claimCallJob(shop: string, id: string) {
  return db.$transaction(async (tx) => {
    const initial = await tx.callJob.findFirst({ where: { shop, id } });
    if (!initial) return false;
    await tx.$queryRaw`SELECT id FROM "Checkout" WHERE shop = ${shop} AND "checkoutId" = ${initial.checkoutId} FOR UPDATE`;
    const job = await tx.callJob.findFirst({ where: { shop, id, status: "QUEUED" } });
    if (!job) return false;
    const checkout = await tx.checkout.findUnique({ where: { shop_checkoutId: { shop, checkoutId: job.checkoutId } } });
    const settings = await tx.settings.findUnique({ where: { shop } });
    let reason: string | null = null;
    if (!checkout || checkout.status !== "ABANDONED") reason = "CHECKOUT_NOT_ABANDONED";
    else if (job.providerCallId) reason = "CALL_ALREADY_STARTED";
    else if (!settings?.enabled) {
      await tx.callJob.update({ where: { id }, data: { outcome: "AUTOMATION_PAUSED" } });
      return false;
    }
    const history = await tx.callJob.findMany({ where: { shop, checkoutId: job.checkoutId }, select: { id: true, attempts: true, providerCallId: true, status: true } });
    const used = history.reduce((sum, row) => sum + Math.max(row.attempts, row.providerCallId ? 1 : 0), 0);
    if (!reason && used >= attemptLimit(settings?.maxAttempts)) reason = "MAX_ATTEMPTS_REACHED";
    if (reason) {
      await tx.callJob.update({ where: { id }, data: { status: "CANCELED", outcome: reason } });
      return false;
    }
    if (history.some(row => row.id !== id && row.status === "CALLING")) return false;
    const result = await tx.callJob.updateMany({ where: { shop, id, status: "QUEUED" }, data: { status: "CALLING", attempts: { increment: 1 }, outcome: null } });
    return result.count === 1;
  });
}
