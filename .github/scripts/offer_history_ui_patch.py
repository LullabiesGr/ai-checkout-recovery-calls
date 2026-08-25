from pathlib import Path

# Checkouts should show the latest real offer for the checkout, even if the newest call had no offer.
p = Path('app/routes/app.checkouts.tsx')
s = p.read_text()
marker = '''  const latestJobMap = pickLatestJobByCheckout(jobs);\n  const recoveredOrderMap = buildRecoveredOrderMap(orders);\n'''
if 'const latestOfferByCheckout' not in s and marker in s:
    insert = '''  const latestOfferByCheckout = new Map<string, ReturnType<typeof parseCheckoutOffer>>();\n  for (const job of jobs as any[]) {\n    const checkoutKey = safeStr(job?.checkoutId).trim();\n    if (!checkoutKey || latestOfferByCheckout.has(checkoutKey)) continue;\n    const parsed = parseCheckoutOffer(job?.analysisJson);\n    if (parsed.code || parsed.smsSentAt || parsed.smsMessageId) latestOfferByCheckout.set(checkoutKey, parsed);\n  }\n'''
    s = s.replace(marker, marker + insert, 1)
s = s.replace(
    '    const offer = parseCheckoutOffer((j as any)?.analysisJson);',
    '    const offer = latestOfferByCheckout.get(checkoutId) ?? parseCheckoutOffer((j as any)?.analysisJson);',
    1,
)
p.write_text(s)

# Direct checkout detail should follow the same rule.
p = Path('app/routes/app.checkouts.$checkoutId.tsx')
s = p.read_text()
old = '    offer: parseOffer((j as any)?.analysisJson),\n'
if old in s:
    new = '''    offer: (() => {\n      for (const job of jobs as any[]) {\n        const parsed = parseOffer(job?.analysisJson);\n        if (parsed.code || parsed.smsSentAt || parsed.smsMessageId) return parsed;\n      }\n      return parseOffer((j as any)?.analysisJson);\n    })(),\n'''
    s = s.replace(old, new, 1)
p.write_text(s)
