from pathlib import Path

path = Path('app/callProvider.server.ts')
s = path.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    s = s.replace(old, new, 1)
    print(f'patched: {label}')


# 1) Preserve the merchant's SMS template formatting exactly and add an
#    auto-apply discount URL helper.
old_compact = '''function compactCheckoutUrl(urlStr: string) {
  const raw = String(urlStr ?? "").trim();
  if (!raw) return raw;

  try {
    const u = new URL(raw);
    u.searchParams.delete("locale");
    u.searchParams.delete("discount");
    return u.toString();
  } catch {
    return raw;
  }
}

function normalizePrefix(prefix: string | null) {'''

new_compact = '''function compactCheckoutUrl(urlStr: string) {
  const raw = String(urlStr ?? "").trim();
  if (!raw) return raw;

  try {
    const u = new URL(raw);
    u.searchParams.delete("locale");
    u.searchParams.delete("discount");
    return u.toString();
  } catch {
    return raw;
  }
}

function checkoutUrlWithOfferCode(urlStr: string, code: string | null | undefined) {
  const raw = String(urlStr ?? "").trim();
  const offerCode = String(code ?? "").trim();
  if (!raw || !offerCode) return raw;

  try {
    const u = new URL(raw);
    u.searchParams.set("discount", offerCode);
    return u.toString();
  } catch {
    return raw;
  }
}

function normalizePrefix(prefix: string | null) {'''
replace_once(old_compact, new_compact, 'discount-link helper')

old_sms_text = '''function buildSmsText(args: {
  templateOffer?: string | null;
  templateNoOffer?: string | null;
  vars: Record<string, string>;
  hasOffer: boolean;
}) {
  const defaultOfferTemplate = "Checkout: {{checkout_link}} Code: {{offer_code}}";
  const defaultNoOfferTemplate = "Checkout: {{checkout_link}}";

  const tpl = args.hasOffer
    ? String(args.templateOffer ?? "").trim() || defaultOfferTemplate
    : String(args.templateNoOffer ?? "").trim() || defaultNoOfferTemplate;

  const out = applyTemplate(tpl, args.vars)
    .replace(/\\s+/g, " ")
    .trim();

  if (out) return out;

  return args.hasOffer
    ? `Checkout: ${args.vars.checkout_link} Code: ${args.vars.offer_code}`.replace(/\\s+/g, " ").trim()
    : `Checkout: ${args.vars.checkout_link}`.replace(/\\s+/g, " ").trim();
}'''

new_sms_text = '''function buildSmsText(args: {
  templateOffer?: string | null;
  templateNoOffer?: string | null;
  vars: Record<string, string>;
  hasOffer: boolean;
}) {
  const defaultOfferTemplate = "Checkout: {{checkout_link}}\\nCode: {{offer_code}}";
  const defaultNoOfferTemplate = "Checkout: {{checkout_link}}";

  const tpl = args.hasOffer
    ? String(args.templateOffer ?? "").trim() || defaultOfferTemplate
    : String(args.templateNoOffer ?? "").trim() || defaultNoOfferTemplate;

  // The merchant-authored template is the source of truth. Preserve its
  // line breaks and wording; only substitute supported variables.
  const out = applyTemplate(tpl, args.vars)
    .replace(/\\r\\n/g, "\\n")
    .trim();

  if (out) return out;

  return args.hasOffer
    ? `Checkout: ${args.vars.checkout_link}\\nCode: ${args.vars.offer_code}`.trim()
    : `Checkout: ${args.vars.checkout_link}`.trim();
}'''
replace_once(old_sms_text, new_sms_text, 'merchant SMS template formatting')

# 2) Make the model treat the actual tool call/result as ground truth.
old_sms_block = '''  const smsBlock =
    args.smsEnabled && checkout.phone
      ? `
SMS / OFFER TOOL (tool use):
- Tool name: send_checkout_offer
- Call it exactly ONCE only after the customer accepts the next step.
- Immediately before the tool call, say exactly: "I'll send that by text right now."
- Do not mention SMS, text message, or sending anything by phone unless SMS is actually enabled in this prompt.
- Do not promise that any code or message was sent until the tool succeeds.
- After a successful tool result, confirm briefly that the text was sent.
- If the tool result includes code, speak the coupon code slowly and clearly.
- Always spell the coupon code character by character using the provided speakable form when available.
- For letters, use NATO-style words. For digits, say each digit separately.
- Never rush the code. Pause slightly between characters.
- Never read CHECKOUT_LINK aloud.
- Never spell domains, query parameters, or URL characters aloud.
- You may choose the final offer during the conversation, but you must stay within the configured limits.
- If you choose a discount, pass the exact discountPercent you decided on. Do not exceed the configured maximum.
`.trim()
      : "";'''

new_sms_block = '''  const smsBlock =
    args.smsEnabled && checkout.phone
      ? `
SMS / OFFER TOOL (tool use):
- Tool name: send_checkout_offer.
- Call it exactly ONCE only after the customer accepts receiving the link/code by SMS.
- The moment the customer clearly accepts the SMS, your NEXT action MUST be the send_checkout_offer tool call. Do not send a normal assistant message first.
- Vapi will automatically speak the request-start message when the real tool call begins. Never imitate that message yourself.
- Never output stage directions such as [Sending...], never pretend a tool ran, and never claim an SMS was sent without a tool result.
- Treat the tool result JSON as ground truth.
- Say the SMS was sent ONLY when the tool result contains sms_sent=true.
- If sms_sent=false, clearly say the text could not be sent. If the result contains a real code/code_speakable, you may give that exact code verbally.
- Never invent, guess, shorten, or transform a coupon code. Only use code/code_speakable returned by the tool.
- If the tool result includes code_speakable, read that exact form slowly with short pauses.
- Never read CHECKOUT_LINK aloud.
- Never spell domains, query parameters, or URL characters aloud.
- You may choose the final offer during the conversation, but you must stay within the configured limits.
- If you choose a discount, pass the exact discountPercent you decided on. Do not exceed the configured maximum.
`.trim()
      : "";'''
replace_once(old_sms_block, new_sms_block, 'SMS tool ground-truth prompt')

old_hard_rules = '''- Only mention SMS/text if SMS is enabled in this prompt.
- If you are about to send the SMS, say exactly: "I'll send that by text right now."
- After the tool succeeds, confirm briefly that the text was sent.
- If a coupon code exists, say it slowly and clearly, character by character.
- Prefer the tool-provided speakable code format when available.'''

new_hard_rules = '''- Only mention SMS/text if SMS is enabled in this prompt.
- When the customer accepts receiving an SMS, call send_checkout_offer immediately; do not narrate or simulate the action yourself.
- Never say an SMS was sent unless the tool result explicitly contains sms_sent=true.
- Never invent a coupon code. A code is valid only if it appears in the current tool result.
- If a real coupon code exists in the tool result, say it slowly and clearly using code_speakable when available.'''
replace_once(old_hard_rules, new_hard_rules, 'hard rules for SMS truthfulness')

old_runtime_sms_instruction = '''    messages.push({
      role: "user",
      content:
        `If you need to send the SMS, first say exactly "I'll send that by text right now." and then call the tool. ` +
        `After the tool succeeds, say that the text was sent. ` +
        `If the tool result contains code_speakable, read that form exactly, slowly, with short pauses between parts. ` +
        `If there is only code, spell it character by character, slowly and clearly. ` +
        `Never read the checkout URL aloud. Never spell the domain. Never read query parameters aloud.`,
    });'''

new_runtime_sms_instruction = '''    messages.push({
      role: "user",
      content:
        `When the customer clearly accepts receiving the SMS, do not send a normal assistant message first: your next action must be the send_checkout_offer tool call. ` +
        `Vapi will speak the request-start message automatically when the real tool begins. ` +
        `Afterward, treat the returned JSON as ground truth: say the text was sent only if sms_sent=true. ` +
        `If sms_sent=false, say it could not be sent; if a real code/code_speakable is returned, you may give only that exact code. ` +
        `Never invent a code, never output fake stage directions, and never claim a tool ran when no tool result exists. ` +
        `Never read the checkout URL aloud. Never spell the domain. Never read query parameters aloud.`,
    });'''
replace_once(old_runtime_sms_instruction, new_runtime_sms_instruction, 'runtime SMS tool instruction')

# 3) Make {{discount_link}} actually auto-apply the created Shopify code.
assignment = '          discountLink = compactLink;'
if s.count(assignment) != 2:
    raise SystemExit(f'discountLink assignments: expected 2 matches, found {s.count(assignment)}')
s = s.replace(assignment, '          discountLink = checkoutUrlWithOfferCode(compactLink, offerCode);', 2)
print('patched: auto-apply discount_link assignments')

# 4) If Brevo fails after Shopify created the offer, return the real code
#    with sms_sent=false instead of losing it and inviting hallucination.
old_brevo = '''      const br = await brevoSendSms({
        toE164: to,
        body: smsText,
        sender: smsSender,
        type: process.env.BREVO_SMS_TYPE ?? "transactional",
        tag: process.env.BREVO_SMS_TAG ?? "checkout-recovery",
        organisationPrefix: process.env.BREVO_SMS_ORGANISATION_PREFIX ?? null,
      });

      const messageId = String(br?.messageId ?? "").trim() || null;'''

new_brevo = '''      let br: any = null;
      try {
        br = await brevoSendSms({
          toE164: to,
          body: smsText,
          sender: smsSender,
          type: process.env.BREVO_SMS_TYPE ?? "transactional",
          tag: process.env.BREVO_SMS_TAG ?? "checkout-recovery",
          organisationPrefix: process.env.BREVO_SMS_ORGANISATION_PREFIX ?? null,
        });
      } catch (smsErr: any) {
        const smsError = String(smsErr?.message ?? smsErr ?? "SMS send failed");
        const failureResult = JSON.stringify({
          ok: false,
          sms_sent: false,
          error: "sms_send_failed",
          message: smsError,
          offer_type: finalType,
          code: offerCode ?? null,
          code_speakable: makeSpeakableCouponCode(offerCode),
          discount_percent: finalDiscountPercent,
        });

        await db.callJob.update({
          where: { id: job.id },
          data: {
            analysisJson: mergeAnalysisJson(job.analysisJson ?? null, {
              offer: {
                ...(existingOffer && typeof existingOffer === "object" ? existingOffer : {}),
                checkoutLink: compactLink,
                discountLink,
                offerType: finalType,
                offerCode,
                offerCodeSpeakable: makeSpeakableCouponCode(offerCode),
                discountPercent: finalDiscountPercent,
                couponValidityHours: playbook.couponValidityHours,
                shopifyDiscountNodeId: discountNodeId,
                offerCreateError,
                generatedAt: new Date().toISOString(),
                smsEnabled: true,
                smsFrom: smsSender || null,
                smsText,
                smsSentAt: null,
                smsMessageSid: null,
                smsError,
                compactCheckoutLink: compactLink,
                lastToolCallId: tc.id,
                lastRequestedType: requestedType,
                lastResult: safeJsonParse(failureResult) ?? null,
              },
            }),
          },
        });

        setRecentToolResult(cacheKey, failureResult);
        results.push({
          name: toolName,
          toolCallId: tc.id,
          result: failureResult,
        });
        continue;
      }

      const messageId = String(br?.messageId ?? "").trim() || null;'''
replace_once(old_brevo, new_brevo, 'Brevo failure fallback with real coupon')

# 5) Use a real Vapi tool request-start message and make the tool description
#    explicit that it is mandatory after customer consent.
old_tool = '''                  {
                    type: "function",
                    function: {
                      name: "send_checkout_offer",
                      description:
                        "Send the checkout link by SMS. Optionally create a real Shopify discount or free-shipping code and send it by SMS.",'''

new_tool = '''                  {
                    type: "function",
                    async: false,
                    messages: [
                      {
                        type: "request-start",
                        content: "I'll send that by text right now.",
                        blocking: false,
                      },
                    ],
                    function: {
                      name: "send_checkout_offer",
                      description:
                        "MANDATORY when the customer explicitly accepts receiving the checkout link or offer by SMS. This tool creates the real Shopify offer when needed and sends the merchant-configured SMS. Never claim the SMS was sent without calling this tool and reading its result.",'''
replace_once(old_tool, new_tool, 'Vapi request-start tool message')

path.write_text(s, encoding='utf-8')
print('SMS flow patch complete')
