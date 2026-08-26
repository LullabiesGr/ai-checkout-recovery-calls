from pathlib import Path

provider = Path('app/callProvider.server.ts')
s = provider.read_text()

# Restore the live-call SMS behavior that worked in the 14:24 test: the
# send_checkout_offer tool must be available whenever the plan/transport/link
# are valid. Automated post-call follow-up preference is a separate concern.
old_gate = '''  const smsEnabled =
    smsFeatureAllowedByPlan &&
    Boolean(playbook.followupSmsEnabled) &&
    hasSmsTransport &&
    Boolean(compactRecoveryUrl) &&
    Boolean(customerNumber);'''
new_gate = '''  const smsEnabled =
    smsFeatureAllowedByPlan &&
    hasSmsTransport &&
    Boolean(compactRecoveryUrl) &&
    Boolean(customerNumber);'''
if old_gate not in s:
    raise SystemExit('Expected smsEnabled gate not found')
s = s.replace(old_gate, new_gate, 1)

old_handler_gate = '''        freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),
        followupSmsEnabled: smsFeatureAllowedByPlan && Boolean(extras?.followup_sms_enabled ?? false),
      };

      if (!playbook.followupSmsEnabled) throw new Error("SMS follow-up is disabled for this shop.");'''
new_handler_gate = '''        freeShippingEnabled: Boolean(extras?.free_shipping_enabled ?? false),
      };'''
if old_handler_gate not in s:
    raise SystemExit('Expected tool-handler SMS follow-up gate not found')
s = s.replace(old_handler_gate, new_handler_gate, 1)

# Restore the coupon speech behavior from the exact working snapshot before
# 14:24 (NATO letters + deliberate pauses).
s = s.replace('if (/[A-Z]/.test(ch)) return ch;', 'if (/[A-Z]/.test(ch)) return natoWord(ch);', 1)
s = s.replace('return parts.length ? parts.join(", ") : null;', 'return parts.length ? parts.join(" ... ") : null;', 1)
s = s.replace(
    '- If the tool result includes code_speakable, read that exact form slowly. Commas indicate pauses only; never say the words dot, period, comma, separator, or punctuation.',
    '- If the tool result includes code_speakable, read that exact form slowly with short pauses.',
    1,
)
s = s.replace(
    'If sms_sent=false, say it could not be sent; if a real code/code_speakable is returned, you may give only that exact code. When reading code_speakable, commas are silent pauses only; never say dot, period, comma, separator, or punctuation. ',
    'If sms_sent=false, say it could not be sent; if a real code/code_speakable is returned, you may give only that exact code. ',
    1,
)

provider.write_text(s)
