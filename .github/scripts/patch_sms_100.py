from pathlib import Path

settings = Path('app/routes/app.settings.tsx')
s = settings.read_text()

s = s.replace(
    'const smsTemplateLimit = (value: string) => /[^\\x00-\\x7F]/.test(value) ? 70 : 160;',
    'const smsTemplateLimit = (_value: string) => 100;'
)
s = s.replace(
    'const smsTemplateOffer = smsTemplateOfferRaw ? smsTemplateOfferRaw : null;',
    'const smsTemplateOffer = smsTemplateOfferRaw ? Array.from(smsTemplateOfferRaw).slice(0, 100).join("") : null;'
)
s = s.replace(
    'const smsTemplateNoOffer = smsTemplateNoOfferRaw ? smsTemplateNoOfferRaw : null;',
    'const smsTemplateNoOffer = smsTemplateNoOfferRaw ? Array.from(smsTemplateNoOfferRaw).slice(0, 100).join("") : null;'
)
s = s.replace(
    'One SMS segment only: 160 GSM/ASCII or 70 Unicode. The final rendered SMS is checked again before sending. Use {{discount_link}}.',
    'Template limit: 100 characters to leave room for the Shopify checkout URL. Use {{discount_link}}.'
)
s = s.replace(
    'One SMS segment only: 160 GSM/ASCII or 70 Unicode. The final rendered SMS is checked again before sending. Use {{checkout_link}}.',
    'Template limit: 100 characters to leave room for the Shopify checkout URL. Use {{checkout_link}}.'
)
settings.write_text(s)

provider = Path('app/callProvider.server.ts')
s = provider.read_text()
old = '''const body = String(params.body ?? "").trim();
const segment = smsSingleSegmentInfo(body);
if (segment.units > segment.limit) {
  throw new Error(`SMS exceeds one-segment limit (${segment.encoding}): ${segment.units}/${segment.limit}. Shorten the SMS template.`);
}

const payload: Record<string, any> = {
  sender,
  recipient,
  content: body,
  type: normalizeBrevoType(params.type ?? process.env.BREVO_SMS_TYPE),
};
if (segment.encoding === "unicode") payload.unicodeEnabled = true;'''
new = '''const body = String(params.body ?? "").trim();

const payload: Record<string, any> = {
  sender,
  recipient,
  content: body,
  type: normalizeBrevoType(params.type ?? process.env.BREVO_SMS_TYPE),
};
if (/[^\\x00-\\x7F]/.test(body)) payload.unicodeEnabled = true;'''
if old in s:
    s = s.replace(old, new, 1)
provider.write_text(s)
