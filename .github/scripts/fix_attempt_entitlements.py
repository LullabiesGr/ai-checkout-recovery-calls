from pathlib import Path
import re

# Plans: FREE really includes 10 attempts.
p = Path('app/lib/billingPlans.shared.ts')
s = p.read_text()
s = re.sub(r'(FREE:\s*\{[\s\S]*?includedAttempts:\s*)\d+', r'\g<1>10', s, count=1)
p.write_text(s)

# Billing backend: keep attempt counters aligned with plan + Shopify billing cycle.
p = Path('app/lib/billing.server.ts')
s = p.read_text()

# Ask Shopify for the active subscription period end so included attempts renew with the billing cycle.
s = s.replace('''      status\n      lineItems {''', '''      status\n      currentPeriodEnd\n      lineItems {''', 1)

# When there is no paid subscription, FREE is the source of truth. Reset paid-cycle usage only when entering FREE.
old = '''          appliedCouponCode: null,\n        },'''
new = '''          appliedCouponCode: null,\n          includedSecondsUsed: row.plan === "FREE" ? row.includedSecondsUsed : 0,\n          freeSecondsUsed: row.plan === "FREE" ? row.freeSecondsUsed : 0,\n          currentPeriodStart: null,\n          currentPeriodEnd: null,\n        },'''
# Only the first occurrence is syncBillingFromShopify's !ours branch.
s = s.replace(old, new, 1)

# Before updating an active subscription, detect plan/cycle transitions.
needle = '''    const normalizedPlan: PlanKey =\n      detectedPlan ??\n      (currentRowPlan !== "FREE"\n        ? currentRowPlan\n        : recurringLine\n          ? "STARTER"\n          : usageLine\n            ? "PAYG"\n            : "FREE");\n\n    await tx.shopBilling.update({'''
replacement = '''    const normalizedPlan: PlanKey =\n      detectedPlan ??\n      (currentRowPlan !== "FREE"\n        ? currentRowPlan\n        : recurringLine\n          ? "STARTER"\n          : usageLine\n            ? "PAYG"\n            : "FREE");\n\n    const nextPeriodEnd = ours?.currentPeriodEnd ? new Date(ours.currentPeriodEnd) : null;\n    const previousPeriodEnd = row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null;\n    const planChanged = normalizedPlan !== currentRowPlan;\n    const billingCycleChanged = Boolean(\n      status === "ACTIVE" &&\n      nextPeriodEnd &&\n      (!previousPeriodEnd || previousPeriodEnd.getTime() !== nextPeriodEnd.getTime())\n    );\n    const resetIncludedAttempts = planChanged || billingCycleChanged;\n\n    await tx.shopBilling.update({'''
if needle not in s:
    raise SystemExit('normalizedPlan block not found')
s = s.replace(needle, replacement, 1)

needle = '''        recurringLineItemId: recurringLine?.id ?? null,\n      },'''
replacement = '''        recurringLineItemId: recurringLine?.id ?? null,\n        includedSecondsUsed: resetIncludedAttempts ? 0 : row.includedSecondsUsed,\n        freeSecondsUsed: normalizedPlan === "FREE" && planChanged ? 0 : row.freeSecondsUsed,\n        currentPeriodStart: resetIncludedAttempts ? new Date() : row.currentPeriodStart,\n        currentPeriodEnd: nextPeriodEnd,\n      },'''
if needle not in s:
    raise SystemExit('active billing update block not found')
s = s.replace(needle, replacement, 1)

# Make FREE hard-stop at its included attempt allowance.
needle = '''    if (planKey === "FREE") {\n      await tx.shopBilling.update({\n        where: { shop },\n        data: { freeSecondsUsed: Number(billing.freeSecondsUsed || 0) + 1 },\n      });'''
replacement = '''    if (planKey === "FREE") {\n      const freeUsed = Number(billing.freeSecondsUsed || 0);\n      const freeLimit = Number(PLANS.FREE.includedAttempts || 10);\n      if (freeUsed >= freeLimit) {\n        throw new Error("FREE_ATTEMPT_LIMIT_REACHED");\n      }\n      await tx.shopBilling.update({\n        where: { shop },\n        data: { freeSecondsUsed: freeUsed + 1 },\n      });'''
if needle not in s:
    raise SystemExit('FREE billing block not found')
s = s.replace(needle, replacement, 1)

# Expose a preflight used by the call runner. Paid plans may continue into overage; FREE stops at 10.
marker = '\nexport async function applyBillingForCall(args: {'
if 'export async function getAttemptAvailability(' not in s:
    helper = '''\nexport async function getAttemptAvailability(shop: string) {\n  const billing = await ensureBillingRow(shop);\n  const planKey: PlanKey = isPlanKey(billing.plan) ? (billing.plan as PlanKey) : "FREE";\n  const plan = PLANS[planKey] ?? PLANS.FREE;\n\n  if (planKey === "FREE") {\n    const used = Number(billing.freeSecondsUsed || 0);\n    const included = Number(PLANS.FREE.includedAttempts || 10);\n    return {\n      plan: planKey,\n      allowed: used < included,\n      included,\n      used,\n      remainingIncluded: Math.max(0, included - used),\n    };\n  }\n\n  const used = Number(billing.includedSecondsUsed || 0);\n  const included = Number(plan.includedAttempts || 0);\n  return {\n    plan: planKey,\n    allowed: true,\n    included,\n    used,\n    remainingIncluded: Math.max(0, included - used),\n  };\n}\n'''
    if marker not in s:
        raise SystemExit('applyBilling marker not found')
    s = s.replace(marker, helper + marker, 1)

p.write_text(s)

# Billing route: resetting to FREE must grant a fresh 10-attempt FREE allowance.
p = Path('app/routes/app.billing.tsx')
s = p.read_text()
needle = '''            appliedCouponCode: null,\n          },'''
replacement = '''            appliedCouponCode: null,\n            includedSecondsUsed: 0,\n            freeSecondsUsed: 0,\n            currentPeriodStart: null,\n            currentPeriodEnd: null,\n          },'''
if needle not in s:
    raise SystemExit('FREE selection billing update not found')
s = s.replace(needle, replacement, 1)
# Use plan config as the single source of truth instead of a hard-coded 10.
s = s.replace('const freeRemainingAttempts = Math.max(0, 10 - Number(billing?.freeSecondsUsed || 0));', 'const freeRemainingAttempts = Math.max(0, PLANS.FREE.includedAttempts - Number(billing?.freeSecondsUsed || 0));')
s = s.replace('€0/month • 10 call attempts • SMS included with every attempt', '€0/month • {p.includedAttempts} call attempts • SMS included with every attempt')
p.write_text(s)

# Call runner: refuse FREE calls after allowance is exhausted, before a provider call starts.
p = Path('app/routes/api.run-calls.ts')
s = p.read_text()
s = s.replace('import { startVapiCallForJob } from "../callProvider.server";', 'import { startVapiCallForJob } from "../callProvider.server";\nimport { getAttemptAvailability } from "../lib/billing.server";')
s = s.replace('''  let canceled = 0;\n\n  for (const job of jobs) {''', '''  let canceled = 0;\n  const freeStartsThisRun = new Map<string, number>();\n\n  for (const job of jobs) {\n    const attemptAvailability = await getAttemptAvailability(job.shop);\n    const locallyStartedFree = freeStartsThisRun.get(job.shop) ?? 0;\n    const freeRemainingForThisRun = attemptAvailability.remainingIncluded - locallyStartedFree;\n\n    if (attemptAvailability.plan === "FREE" && (!attemptAvailability.allowed || freeRemainingForThisRun <= 0)) {\n      await db.callJob.update({\n        where: { id: job.id },\n        data: {\n          status: "FAILED",\n          outcome: "FREE_ATTEMPT_LIMIT_REACHED",\n        },\n      });\n      failed += 1;\n      continue;\n    }''', 1)
s = s.replace('''      started += 1;\n    } catch (e: any) {''', '''      if (attemptAvailability.plan === "FREE") {\n        freeStartsThisRun.set(job.shop, locallyStartedFree + 1);\n      }\n      started += 1;\n    } catch (e: any) {''', 1)
p.write_text(s)

print('attempt entitlement patch applied')
