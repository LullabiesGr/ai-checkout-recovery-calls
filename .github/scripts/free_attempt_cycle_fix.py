from pathlib import Path

p = Path('app/lib/billing.server.ts')
s = p.read_text()
old = '''    if (!ours) {\n      await tx.shopBilling.update({\n        where: { shop },\n        data: {\n          plan: "FREE",\n          status: "NONE",\n          subscriptionId: null,\n          usageLineItemId: null,\n          recurringLineItemId: null,\n          pendingPlan: null,\n          pendingCouponId: null,\n          pendingCouponCode: null,\n          appliedCouponCode: null,\n          includedSecondsUsed: row.plan === "FREE" ? row.includedSecondsUsed : 0,\n          freeSecondsUsed: row.plan === "FREE" ? row.freeSecondsUsed : 0,\n          currentPeriodStart: null,\n          currentPeriodEnd: null,\n        },\n      });\n      return;\n    }'''
new = '''    if (!ours) {\n      const now = new Date();\n      const existingFreePeriodEnd = row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null;\n      const enteringFree = row.plan !== "FREE";\n      const freeCycleExpired = !existingFreePeriodEnd || existingFreePeriodEnd.getTime() <= now.getTime();\n      const resetFreeAttempts = enteringFree || freeCycleExpired;\n      const nextFreePeriodEnd = resetFreeAttempts\n        ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)\n        : existingFreePeriodEnd;\n\n      await tx.shopBilling.update({\n        where: { shop },\n        data: {\n          plan: "FREE",\n          status: "NONE",\n          subscriptionId: null,\n          usageLineItemId: null,\n          recurringLineItemId: null,\n          pendingPlan: null,\n          pendingCouponId: null,\n          pendingCouponCode: null,\n          appliedCouponCode: null,\n          includedSecondsUsed: 0,\n          freeSecondsUsed: resetFreeAttempts ? 0 : row.freeSecondsUsed,\n          currentPeriodStart: resetFreeAttempts ? now : row.currentPeriodStart,\n          currentPeriodEnd: nextFreePeriodEnd,\n        },\n      });\n      return;\n    }'''
if old not in s:
    raise SystemExit('FREE sync block not found')
s = s.replace(old, new, 1)
p.write_text(s)
print('free attempt cycle fix applied')
