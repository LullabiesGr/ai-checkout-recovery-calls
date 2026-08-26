from pathlib import Path
import re

# 1) SMS available on every plan
p = Path('app/lib/planFeatures.server.ts')
s = p.read_text()
s = s.replace('export const SMS_ALLOWED_PLANS: BillingPlan[] = ["PRO", "SCALE"];', 'export const SMS_ALLOWED_PLANS: BillingPlan[] = ["FREE", "STARTER", "PRO", "SCALE", "PAYG"];')
s = re.sub(r'export function hasSmsFeature\([\s\S]*?\n}\n\nexport async function getShopPlan', '''export function hasSmsFeature(_plan: BillingPlan | string | null | undefined) {\n  return true;\n}\n\nexport async function getShopPlan''', s, count=1)
s = re.sub(r'export async function assertSmsFeature\([\s\S]*?\n}\s*$', '''export async function assertSmsFeature(shop: string) {\n  const plan = await getShopPlan(shop);\n  return { plan };\n}\n''', s, count=1)
p.write_text(s)

# 2) Billing plan units: attempts, not minutes
p = Path('app/lib/billingPlans.shared.ts')
s = p.read_text()
s = s.replace('includedMinutes: number;', 'includedAttempts: number;')
s = s.replace('overageEURPerMin: number;', 'overageEURPerAttempt: number;')
s = s.replace('includedMinutes:', 'includedAttempts:')
s = s.replace('overageEURPerMin:', 'overageEURPerAttempt:')
s = re.sub(r'\nexport function minutesToSeconds\([\s\S]*?\n}\s*$', '\n', s, count=1)
p.write_text(s)

# 3) Settings: SMS always available + always-on after-call behavior
p = Path('app/routes/app.settings.tsx')
s = p.read_text()
s = s.replace('const smsFeatureAllowed = hasSmsFeature(billingPlan);', 'const smsFeatureAllowed = true;')
s = s.replace('followupSmsEnabled: smsFeatureAllowed ? Boolean(extras?.followup_sms_enabled ?? false) : false,', 'followupSmsEnabled: true,')
s = s.replace('brevoSmsSender: smsFeatureAllowed ? String(extras?.brevoSmsSender ?? "").trim() : "",', 'brevoSmsSender: String(extras?.brevoSmsSender ?? "").trim(),')
s = s.replace('const requestedFollowupSmsEnabled = toBool(fd.get("followupSmsEnabled"));\n  const followupSmsEnabled = smsFeatureAllowed ? requestedFollowupSmsEnabled : false;', 'const followupSmsEnabled = true;')
s = s.replace('const finalBrevoSmsSender = smsFeatureAllowed ? brevoSmsSender : null;\n  const finalSmsTemplateOffer = smsFeatureAllowed ? smsTemplateOffer : null;\n  const finalSmsTemplateNoOffer = smsFeatureAllowed ? smsTemplateNoOffer : null;', 'const finalBrevoSmsSender = brevoSmsSender;\n  const finalSmsTemplateOffer = smsTemplateOffer;\n  const finalSmsTemplateNoOffer = smsTemplateNoOffer;')
# Remove locked-plan warning and make SMS always-on indicator
s = re.sub(r'\n\s*\{!smsFeatureAllowed \? \([\s\S]*?\) : null\}\n', '\n', s, count=1)
s = s.replace('''                    <Checkbox\n                      label="Allow follow-up SMS suggestion"\n                      checked={followupSmsEnabled}\n                      onChange={setFollowupSmsEnabled}\n                      disabled={!smsFeatureAllowed}\n                    />''', '''                    <Checkbox\n                      label="Send SMS after every call"\n                      checked={true}\n                      onChange={() => {}}\n                      disabled\n                    />''')
s = s.replace('disabled={!smsFeatureAllowed || !followupSmsEnabled}', 'disabled={false}')
p.write_text(s)

# 4) Call activity: expose the exact SMS text
p = Path('app/routes/app.calls.tsx')
s = p.read_text()
s = s.replace('if (!offer) return { code: null, type: null, percent: null, smsSentAt: null, smsMessageId: null };', 'if (!offer) return { code: null, type: null, percent: null, smsSentAt: null, smsMessageId: null, smsText: null };')
s = s.replace('smsMessageId: safeStr(offer.smsMessageSid).trim() || null,', 'smsMessageId: safeStr(offer.smsMessageSid).trim() || null,\n    smsText: safeStr(offer.smsText).trim() || null,')
s = s.replace('smsMessageId: offer.smsMessageId,', 'smsMessageId: offer.smsMessageId,\n      smsText: offer.smsText,')
p.write_text(s)

p = Path('app/components/calls/CallActivityView.tsx')
s = p.read_text()
s = s.replace('smsMessageId: string | null;', 'smsMessageId: string | null;\n  smsText: string | null;')
needle = '''                      <Text as="p" variant="bodySm" tone={selected.smsSentAt ? "success" : "subdued"}>\n                        {selected.smsSentAt ? `SMS sent ${when(selected.smsSentAt)}` : "SMS not sent"}\n                      </Text>'''
replacement = needle + '''\n                      {selected.smsText ? (\n                        <Box background="bg-surface" borderRadius="200" padding="250">\n                          <BlockStack gap="100">\n                            <Text as="p" variant="bodySm" fontWeight="semibold">Message sent</Text>\n                            <Text as="p" variant="bodySm">{selected.smsText}</Text>\n                          </BlockStack>\n                        </Box>\n                      ) : null}'''
if needle in s:
    s = s.replace(needle, replacement, 1)
p.write_text(s)

# 5) Billing route: attempts wording and counters
p = Path('app/routes/app.billing.tsx')
s = p.read_text()
s = s.replace('const freeRemainingSec = Math.max(0, 10 * 60 - Number(billing?.freeSecondsUsed || 0));\n  const freeRemainingMin = Math.floor(freeRemainingSec / 60);', 'const freeRemainingAttempts = Math.max(0, 10 - Number(billing?.freeSecondsUsed || 0));')
s = s.replace('const includedUsedSec = Number(billing?.includedSecondsUsed || 0);\n  const includedTotalSec = plan.includedMinutes * 60;\n  const includedRemainingMin = Math.max(0, Math.floor((includedTotalSec - includedUsedSec) / 60));', 'const includedAttemptsUsed = Number(billing?.includedSecondsUsed || 0);\n  const includedRemainingAttempts = Math.max(0, plan.includedAttempts - includedAttemptsUsed);')
s = s.replace('Free minutes remaining: <b>{freeRemainingMin} min</b>', 'Free attempts remaining: <b>{freeRemainingAttempts}</b>')
s = s.replace('Included minutes remaining (this cycle): <b>{includedRemainingMin} min</b>', 'Included attempts remaining (this cycle): <b>{includedRemainingAttempts}</b>')
s = s.replace('€0/month • 10 free phone minutes (one-time)', '€0/month • 10 call attempts • SMS included with every attempt')
s = s.replace('€{p.overageEURPerMin.toFixed(2)}/min', '€{p.overageEURPerAttempt.toFixed(2)}/attempt')
s = s.replace('{p.includedMinutes} included min • €\n                          {p.overageEURPerMin.toFixed(2)}/min after', '{p.includedAttempts} included attempts • €\n                          {p.overageEURPerAttempt.toFixed(2)}/attempt after')
p.write_text(s)

# 6) Billing backend: charge by attempt, not duration
p = Path('app/lib/billing.server.ts')
s = p.read_text()
s = re.sub(r'\nfunction ceilMinutesFromSeconds\([\s\S]*?\n}\n', '\n', s, count=1)
start = s.index('export async function applyBillingForCall(args: {')
end = s.index('\nfunction usageTermsForPlan(plan: PlanKey)', start)
new_fn = r'''export async function applyBillingForCall(args: {
  shop: string;
  admin?: AdminLike;
  callJobId: string;
  connectedSeconds: number;
  answered: boolean;
  voicemail?: boolean;
}) {
  const { shop, admin, callJobId } = args;
  const rawSeconds = Math.max(0, Math.floor(Number(args.connectedSeconds) || 0));

  await db.$transaction(async (tx) => {
    const exists = await tx.callCharge.findUnique({ where: { callJobId } });
    if (exists) return;

    let billing = await tx.shopBilling.upsert({
      where: { shop },
      update: {},
      create: { shop },
    });

    let planKey: PlanKey = isPlanKey(billing.plan) ? (billing.plan as PlanKey) : "FREE";

    if (planKey !== "FREE" && !billing.usageLineItemId) {
      try {
        if (admin) await syncBillingFromShopify({ shop, admin });
        billing = await tx.shopBilling.findUniqueOrThrow({ where: { shop } });
        planKey = isPlanKey(billing.plan) ? (billing.plan as PlanKey) : "FREE";
      } catch (e) {
        throw new Error(`Billing sync failed: ${asErrorMessage(e)}`);
      }
    }

    if (planKey === "FREE") {
      await tx.shopBilling.update({
        where: { shop },
        data: { freeSecondsUsed: Number(billing.freeSecondsUsed || 0) + 1 },
      });
      await tx.callCharge.create({
        data: {
          shop,
          callJobId,
          connectedSeconds: rawSeconds,
          minutesBilled: 0,
          amountCents: 0,
          currencyCode: BILLING_CURRENCY,
          idempotencyKey: idempotencyKeyForCall(callJobId),
        },
      });
      return;
    }

    const p = PLANS[planKey];
    if (!p) throw new Error(`Unknown billing plan: ${String(planKey)}`);

    const used = Number(billing.includedSecondsUsed || 0);
    const isIncluded = used < Number(p.includedAttempts || 0);

    await tx.shopBilling.update({
      where: { shop },
      data: { includedSecondsUsed: used + 1 },
    });

    const amountCents = isIncluded ? 0 : eurToCents(p.overageEURPerAttempt);
    let usageRecordId: string | null = null;

    if (amountCents > 0) {
      if (!billing.usageLineItemId) throw new Error("No usage line item after sync");
      const m = `#graphql
mutation UsageCharge(
  $description: String!
  $price: MoneyInput!
  $subscriptionLineItemId: ID!
  $idempotencyKey: String
) {
  appUsageRecordCreate(
    description: $description
    price: $price
    subscriptionLineItemId: $subscriptionLineItemId
    idempotencyKey: $idempotencyKey
  ) {
    userErrors { field message }
    appUsageRecord { id }
  }
}`;
      const idempotencyKey = idempotencyKeyForCall(callJobId);
      const json = await graphqlShop(shop, m, {
        description: `${p.title}: 1 overage call attempt (${callJobId})`,
        price: { amount: (amountCents / 100).toFixed(2), currencyCode: BILLING_CURRENCY },
        subscriptionLineItemId: billing.usageLineItemId,
        idempotencyKey,
      }, admin);
      if (json?.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join(" | "));
      const payload = json?.data?.appUsageRecordCreate;
      const errs = payload?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e: any) => e.message).join(" | "));
      usageRecordId = payload?.appUsageRecord?.id ?? null;
    }

    await tx.callCharge.create({
      data: {
        shop,
        callJobId,
        connectedSeconds: rawSeconds,
        minutesBilled: 0,
        amountCents,
        currencyCode: BILLING_CURRENCY,
        usageRecordId,
        idempotencyKey: idempotencyKeyForCall(callJobId),
      },
    });
  });
}
'''
s = s[:start] + new_fn + s[end:]
s = re.sub(r'function usageTermsForPlan\(plan: PlanKey\) \{[\s\S]*?\n}\s*$', r'''function usageTermsForPlan(plan: PlanKey) {
  const p = PLANS[plan];
  if (plan === "PAYG") {
    return `€${p.overageEURPerAttempt.toFixed(2)}/call attempt. One attempt is one outbound call; SMS is included with every attempt. Monthly spending cap applies.`;
  }
  return `Includes ${p.includedAttempts} call attempts per billing cycle. Then €${p.overageEURPerAttempt.toFixed(2)}/attempt. SMS is included with every attempt. Usage charges are limited by the approved capped amount.`;
}
''', s, count=1)
p.write_text(s)

# 7) Ensure one SMS per call: if in-call tool already sent, do nothing; otherwise send link-only after call.
p = Path('app/callProvider.server.ts')
s = p.read_text()
if 'export async function ensureCheckoutSmsForCallJob' not in s:
    s += r'''

export async function ensureCheckoutSmsForCallJob(params: { shop: string; callJobId: string }) {
  const job = await db.callJob.findFirst({ where: { id: params.callJobId, shop: params.shop } });
  if (!job) return { sent: false, reason: "job_not_found" };

  const current = readAnalysisJsonObject(job.analysisJson ?? null);
  const currentOffer = current?.offer && typeof current.offer === "object" ? current.offer : {};
  if (currentOffer?.smsSentAt) {
    return { sent: true, alreadySent: true, smsText: currentOffer?.smsText ?? null };
  }

  const checkout = await db.checkout.findFirst({ where: { shop: params.shop, checkoutId: job.checkoutId } });
  if (!checkout) return { sent: false, reason: "checkout_not_found" };

  const recoveryUrl = extractRecoveryUrlFromCheckoutRaw(checkout.raw);
  if (!recoveryUrl) return { sent: false, reason: "missing_recovery_url" };

  const to = String(job.phone ?? checkout.phone ?? "").trim();
  if (!to || !to.startsWith("+")) return { sent: false, reason: "missing_phone" };

  const extras = await readSettingsExtras(params.shop);
  const sender = resolveBrevoSender(extras);
  if (!pickBrevoApiKey() || !sender) return { sent: false, reason: "sms_transport_missing" };

  const compactLink = compactCheckoutUrl(recoveryUrl);
  const offerCode = String(currentOffer?.offerCode ?? "").trim() || null;
  const discountLink = String(currentOffer?.discountLink ?? "").trim() || (offerCode ? checkoutUrlWithOfferCode(compactLink, offerCode) : compactLink);
  const pct = currentOffer?.discountPercent == null ? "" : String(currentOffer.discountPercent);
  const validity = String(currentOffer?.couponValidityHours ?? extras?.coupon_validity_hours ?? 24);

  const smsText = buildSmsText({
    templateOffer: extras?.sms_template_offer ?? null,
    templateNoOffer: extras?.sms_template_no_offer ?? null,
    vars: {
      shop: params.shop,
      shop_name: params.shop.replace(/\.myshopify\.com$/i, ""),
      customer_name: String(checkout.customerName ?? "Customer").trim() || "Customer",
      checkout_id: String(checkout.checkoutId),
      checkout_link: compactLink,
      discount_link: discountLink,
      offer_code: offerCode ?? "",
      percent: pct,
      validity_hours: validity,
    },
    hasOffer: Boolean(offerCode),
  });

  try {
    const br = await brevoSendSms({
      toE164: to,
      body: smsText,
      sender,
      type: process.env.BREVO_SMS_TYPE ?? "transactional",
      tag: process.env.BREVO_SMS_TAG ?? "checkout-recovery",
      organisationPrefix: process.env.BREVO_SMS_ORGANISATION_PREFIX ?? null,
    });
    const messageId = String(br?.messageId ?? "").trim() || null;
    const sentAt = new Date().toISOString();
    await db.callJob.update({
      where: { id: job.id },
      data: {
        analysisJson: mergeAnalysisJson(job.analysisJson ?? null, {
          offer: {
            ...currentOffer,
            checkoutLink: compactLink,
            discountLink,
            offerCode,
            smsEnabled: true,
            smsFrom: sender,
            smsText,
            smsSentAt: sentAt,
            smsMessageSid: messageId,
            autoSentAfterCall: true,
          },
        }),
      },
    });
    return { sent: true, alreadySent: false, smsText, messageId };
  } catch (e: any) {
    const smsError = String(e?.message ?? e ?? "SMS send failed");
    await db.callJob.update({
      where: { id: job.id },
      data: {
        analysisJson: mergeAnalysisJson(job.analysisJson ?? null, {
          offer: { ...currentOffer, smsText, smsSentAt: null, smsError, autoSentAfterCall: true },
        }),
      },
    });
    return { sent: false, reason: "sms_send_failed", error: smsError };
  }
}
'''
p.write_text(s)

# 8) Vapi webhook: preserve offer metadata, then guarantee SMS once per call.
p = Path('app/routes/webhooks.vapi.tsx')
s = p.read_text()
s = s.replace('import { handleVapiToolsWebhook } from "../callProvider.server";', 'import { handleVapiToolsWebhook, ensureCheckoutSmsForCallJob } from "../callProvider.server";')
# Preserve existing offer metadata instead of replacing analysisJson with OpenAI analysis
old = 'analysisJson: safeStr(JSON.stringify(analysis), 8000),'
new = '''analysisJson: (() => {\n            const existing = tryParseJsonObject(String((currentJob as any)?.analysisJson ?? "")) ?? {};\n            return safeStr(JSON.stringify({ ...existing, aiAnalysis: analysis }), 8000);\n          })(),'''
if old in s:
    s = s.replace(old, new, 1)
# Ensure currentJob exists in end-of-call branch by extending the existing lookup assignment where possible
if 'const currentJob = await db.callJob.findFirst' not in s:
    marker = 'answeredForBilling = answered === true;'
    s = s.replace(marker, marker + '\n\n      const currentJob = await db.callJob.findFirst({ where: { id: callJobId, shop } });', 1)
# Guaranteed SMS before billing
marker = '    // BILLING (rounded minutes happens inside applyBillingForCall)'
if marker in s:
    s = s.replace(marker, '''    // Guarantee exactly one SMS for every call attempt. If the live-call tool already sent it, this is a no-op.\n    try {\n      await ensureCheckoutSmsForCallJob({ shop, callJobId });\n    } catch {}\n\n    // BILLING (attempt-based; call duration is stored for analytics only)''', 1)
p.write_text(s)

print('patch applied')
