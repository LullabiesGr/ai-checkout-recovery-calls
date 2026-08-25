from pathlib import Path
import re

# ---------------- Calls route: enrich data and render merchant-friendly Polaris view ----------------
p = Path('app/routes/app.calls.tsx')
s = p.read_text()

s = s.replace(
    'import { Form, useLoaderData, useRevalidator, useRouteError } from "react-router";',
    'import { useLoaderData, useRouteError } from "react-router";'
)

s = re.sub(
    r'import \{\n  Badge,\n  Banner,\n  BlockStack,\n  Box,\n  Button,\n  Card,\n  Divider,\n  IndexTable,\n  InlineGrid,\n  InlineStack,\n  Layout,\n  Page,\n  Text,\n\} from "@shopify/polaris";\n',
    '',
    s,
    count=1,
)

if 'CallActivityView' not in s:
    s = s.replace(
        'import { createVapiCallForJob } from "../callProvider.server";\n',
        'import { createVapiCallForJob } from "../callProvider.server";\nimport { CallActivityView, type CallActivityRow } from "../components/calls/CallActivityView";\n'
    )

s = re.sub(r'type CallRow = \{.*?\n\};', 'type CallRow = CallActivityRow;', s, count=1, flags=re.S)

helper_marker = 'function pickSentSystemPrompt(sb: any): string | null {'
if 'function parseCallOffer' not in s:
    # Insert helpers after pickSentSystemPrompt function.
    m = re.search(r'function pickSentSystemPrompt\(sb: any\): string \| null \{.*?\n\}', s, re.S)
    if not m:
        raise SystemExit('pickSentSystemPrompt helper not found')
    helper = '''\n\nfunction parseJsonSafe(v: any): any {\n  if (!v) return null;\n  if (typeof v === "object") return v;\n  try { return JSON.parse(String(v)); } catch { return null; }\n}\n\nfunction parseCallOffer(v: any) {\n  const j = parseJsonSafe(v);\n  const offer = j?.offer && typeof j.offer === "object" ? j.offer : null;\n  if (!offer) return { code: null, type: null, percent: null, smsSentAt: null, smsMessageId: null };\n  const pct = offer.discountPercent == null ? null : Number(offer.discountPercent);\n  return {\n    code: safeStr(offer.offerCode).trim() || null,\n    type: safeStr(offer.offerType).trim() || null,\n    percent: Number.isFinite(pct as number) ? pct : null,\n    smsSentAt: safeStr(offer.smsSentAt).trim() || null,\n    smsMessageId: safeStr(offer.smsMessageSid).trim() || null,\n  };\n}\n\nfunction callItems(itemsJson: any): any[] {\n  const j = parseJsonSafe(itemsJson) ?? itemsJson;\n  if (Array.isArray(j)) return j;\n  if (Array.isArray(j?.items)) return j.items;\n  if (Array.isArray(j?.lineItems)) return j.lineItems;\n  return [];\n}\n\nfunction callThumb(itemsJson: any): string | null {\n  for (const it of callItems(itemsJson)) {\n    const value = safeStr(it?.imageUrl ?? it?.image ?? it?.thumbnail ?? it?.src).trim();\n    if (value) return value;\n  }\n  return null;\n}\n\nfunction callCartPreview(itemsJson: any): string | null {\n  const items = callItems(itemsJson).slice(0, 3);\n  const parts = items.map((it: any) => {\n    const title = safeStr(it?.title ?? it?.name).trim();\n    const qty = Number(it?.quantity ?? it?.qty ?? 1);\n    return title ? `${title}${qty > 1 ? ` ×${qty}` : ""}` : "";\n  }).filter(Boolean);\n  return parts.length ? parts.join(", ") : null;\n}\n'''
    s = s[:m.end()] + helper + s[m.end():]

# Include analysisJson in jobs query.
s = s.replace(
    '        recordingUrl: true,\n      },',
    '        recordingUrl: true,\n        analysisJson: true,\n      },',
    1,
)

# Enrich calls with checkout and order data after checkoutIds is known.
insert_marker = '  const checkoutIds = jobs.map((j) => String(j.checkoutId ?? "")).filter(Boolean);\n'
if 'const checkoutMap = new Map' not in s:
    enrichment = '''\n  const [checkoutRows, orderRows] = await Promise.all([\n    checkoutIds.length\n      ? db.checkout.findMany({\n          where: { shop, checkoutId: { in: checkoutIds } },\n          select: { checkoutId: true, customerName: true, phone: true, email: true, value: true, currency: true, itemsJson: true },\n        })\n      : Promise.resolve([]),\n    checkoutIds.length\n      ? db.order.findMany({\n          where: { shop, OR: [{ checkoutId: { in: checkoutIds } }, { checkoutToken: { in: checkoutIds } }] },\n          orderBy: { createdAt: "desc" },\n          select: { checkoutId: true, checkoutToken: true, orderId: true, total: true, currency: true, financial: true, createdAt: true },\n        })\n      : Promise.resolve([]),\n  ]);\n\n  const checkoutMap = new Map(checkoutRows.map((c: any) => [String(c.checkoutId), c]));\n  const orderMap = new Map<string, any>();\n  for (const o of orderRows as any[]) {\n    for (const key of [o.checkoutId, o.checkoutToken].map((x) => safeStr(x).trim()).filter(Boolean)) {\n      if (!orderMap.has(key)) orderMap.set(key, o);\n    }\n  }\n'''
    if insert_marker not in s:
        raise SystemExit('calls checkoutIds marker not found')
    s = s.replace(insert_marker, insert_marker + enrichment, 1)

# Add row enrichment inside map.
row_marker = '    const coId = String(j.checkoutId);\n'
if 'const checkout = checkoutMap.get(coId)' not in s:
    s = s.replace(
        row_marker,
        row_marker + '    const checkout: any = checkoutMap.get(coId) ?? null;\n    const recoveredOrder: any = orderMap.get(coId) ?? null;\n    const offer = parseCallOffer((j as any).analysisJson);\n',
        1,
    )

return_marker = '      sentSystemPrompt,\n    };'
if 'customerName: checkout?.customerName' not in s:
    enriched_return = '''      sentSystemPrompt,\n      customerName: checkout?.customerName ?? null,\n      phone: checkout?.phone ?? null,\n      email: checkout?.email ?? null,\n      cartTotal: Number(checkout?.value ?? 0),\n      currency: String(recoveredOrder?.currency ?? checkout?.currency ?? "USD"),\n      thumbUrl: callThumb(checkout?.itemsJson ?? null),\n      cartPreview: callCartPreview(checkout?.itemsJson ?? null),\n      offerCode: offer.code,\n      offerType: offer.type,\n      offerPercent: offer.percent,\n      smsSentAt: offer.smsSentAt,\n      smsMessageId: offer.smsMessageId,\n      recoveredOrderId: recoveredOrder?.orderId ? String(recoveredOrder.orderId) : null,\n      recoveredAmount: recoveredOrder?.total == null ? null : Number(recoveredOrder.total),\n      recoveredFinancial: recoveredOrder?.financial ? String(recoveredOrder.financial) : null,\n    };'''
    if return_marker not in s:
        raise SystemExit('calls return marker not found')
    s = s.replace(return_marker, enriched_return, 1)

# Replace the old UI with the dedicated Polaris component.
if 'return <CallActivityView' not in s:
    s2, n = re.subn(
        r'function statusTone\(status: string\) \{.*?\nexport function ErrorBoundary\(\) \{',
        'export default function Calls() {\n  const { stats, rows, providerConfigured } = useLoaderData<typeof loader>();\n  return <CallActivityView stats={stats} rows={rows} providerConfigured={providerConfigured} />;\n}\n\nexport function ErrorBoundary() {',
        s,
        count=1,
        flags=re.S,
    )
    if n != 1:
        raise SystemExit(f'calls UI replacement failed: {n}')
    s = s2

p.write_text(s)

# ---------------- Shopify abandoned checkout sync: include product images ----------------
p = Path('app/callRecovery.server.ts')
s = p.read_text()
if 'image { url altText }' not in s:
    s = s.replace(
        '                  variantTitle\n                  originalUnitPriceSet { shopMoney { amount currencyCode } }',
        '                  variantTitle\n                  sku\n                  image { url altText }\n                  originalUnitPriceSet { shopMoney { amount currencyCode } }'
    )

if 'image: it?.image?.url ?? null' not in s:
    s = s.replace(
        '          variantTitle: it?.variantTitle ?? null,\n          price: it?.originalUnitPriceSet?.shopMoney?.amount ?? null,',
        '          variantTitle: it?.variantTitle ?? null,\n          sku: it?.sku ?? null,\n          image: it?.image?.url ?? null,\n          imageAlt: it?.image?.altText ?? null,\n          price: it?.originalUnitPriceSet?.shopMoney?.amount ?? null,'
    )
p.write_text(s)

# ---------------- Provider backfill: preserve product images too ----------------
p = Path('app/callProvider.server.ts')
s = p.read_text()
# Add fields to every abandoned-checkout line item query that still lacks them.
s = re.sub(
    r'(variantTitle\s*\n)(\s*)(originalUnitPriceSet \{ shopMoney \{ amount currencyCode \} \})',
    lambda m: m.group(1) + m.group(2) + 'sku\n' + m.group(2) + 'image { url altText }\n' + m.group(2) + m.group(3),
    s,
)
if 'image: it?.image?.url ?? null' not in s:
    s = s.replace(
        '      variantTitle: it?.variantTitle ?? null,\n      price: it?.originalUnitPriceSet?.shopMoney?.amount ?? null,',
        '      variantTitle: it?.variantTitle ?? null,\n      sku: it?.sku ?? null,\n      image: it?.image?.url ?? null,\n      imageAlt: it?.image?.altText ?? null,\n      price: it?.originalUnitPriceSet?.shopMoney?.amount ?? null,'
    )
p.write_text(s)

# ---------------- Checkouts route: sync images, expose coupons, simplify merchant labels ----------------
p = Path('app/routes/app.checkouts.tsx')
s = p.read_text()
s = s.replace(
    'import { ensureSettings } from "../callRecovery.server";',
    'import { ensureSettings, syncAbandonedCheckoutsFromShopify } from "../callRecovery.server";'
)
s = s.replace(
    '  const { session } = await authenticate.admin(request);\n  const shop = session.shop;\n\n  const settings: any = await ensureSettings(shop);',
    '  const { admin, session } = await authenticate.admin(request);\n  const shop = session.shop;\n\n  await syncAbandonedCheckoutsFromShopify({ admin, shop, limit: 100 });\n  const settings: any = await ensureSettings(shop);',
    1,
)

if 'offerCode: string | null;' not in s:
    s = s.replace(
        '  discountPercent?: number | null;\n\n  latestJobId: string | null;',
        '  discountPercent?: number | null;\n\n  offerCode: string | null;\n  offerType: string | null;\n  offerPercent: number | null;\n  smsSentAt: string | null;\n  smsMessageId: string | null;\n\n  latestJobId: string | null;'
    )

if 'function parseCheckoutOffer' not in s:
    marker = 'function pickThumbFromItem(it: CartItemLite): string {'
    helper = '''function parseCheckoutOffer(v: any) {\n  const j = safeJsonParse<any>(v);\n  const offer = j?.offer && typeof j.offer === "object" ? j.offer : null;\n  if (!offer) return { code: null, type: null, percent: null, smsSentAt: null, smsMessageId: null };\n  const pct = offer.discountPercent == null ? null : Number(offer.discountPercent);\n  return {\n    code: safeStr(offer.offerCode).trim() || null,\n    type: safeStr(offer.offerType).trim() || null,\n    percent: Number.isFinite(pct as number) ? pct : null,\n    smsSentAt: safeStr(offer.smsSentAt).trim() || null,\n    smsMessageId: safeStr(offer.smsMessageSid).trim() || null,\n  };\n}\n\n'''
    if marker not in s:
        raise SystemExit('checkout offer helper marker not found')
    s = s.replace(marker, helper + marker, 1)

# select analysisJson in checkout jobs query
first_jobs_block = '        providerCallId: true,\n        recordingUrl: true,\n      },\n    }),\n  ]);'
if first_jobs_block in s:
    s = s.replace(
        first_jobs_block,
        '        providerCallId: true,\n        recordingUrl: true,\n        analysisJson: true,\n      },\n    }),\n  ]);',
        1,
    )

if 'const offer = parseCheckoutOffer((j as any)?.analysisJson)' not in s:
    s = s.replace(
        '    const order = recoveredOrderMap.get(checkoutId) ?? null;\n',
        '    const order = recoveredOrderMap.get(checkoutId) ?? null;\n    const offer = parseCheckoutOffer((j as any)?.analysisJson);\n',
        1,
    )

if 'offerCode: offer.code' not in s:
    s = s.replace(
        '      discountPercent:\n        discountPercent == null ? discountPercent : Number.isFinite(discountPercent) ? discountPercent : null,\n\n      latestJobId:',
        '      discountPercent:\n        discountPercent == null ? discountPercent : Number.isFinite(discountPercent) ? discountPercent : null,\n\n      offerCode: offer.code,\n      offerType: offer.type,\n      offerPercent: offer.percent,\n      smsSentAt: offer.smsSentAt,\n      smsMessageId: offer.smsMessageId,\n\n      latestJobId:',
        1,
    )

# Friendly language and shorter IDs.
s = s.replace('Uses Order.total as source of truth', 'Completed Shopify orders only')
s = s.replace('Eligible abandoned (min value + contact)', 'Eligible abandoned checkouts')
s = s.replace('wins / (wins + eligible at-risk)', 'Recovered / total recovery opportunities')
s = s.replace('Recovered wins', 'Recovered orders')
s = s.replace('Action queue', 'Recovery queue')
s = s.replace('Signals', 'Status')
s = s.replace('Customer / Cart', 'Customer & cart')
s = s.replace('<s-text tone="subdued" variant="bodySm">#{id}</s-text>', '<s-text tone="subdued" variant="bodySm">Checkout …{id.slice(-10)}</s-text>')

# Simplify row status badges and surface real coupon.
old_status = '''                                <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>\n                                  <s-badge tone={checkoutTone}>{safeStr(r.status).toUpperCase()}</s-badge>\n                                  <s-badge tone={callTone}>{r.callStatus ? safeStr(r.callStatus).toUpperCase() : "NO CALL"}</s-badge>\n                                  <s-badge tone={outcomeTone}>{outcomeLabel(r.callOutcome)}</s-badge>\n                                  <s-badge tone={typeof r.buyProbabilityPct === "number" ? "info" : "neutral"}>{buyBadge}</s-badge>\n                                </s-stack>'''
new_status = '''                                <s-stack gap="tight">\n                                  <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>\n                                    <s-badge tone={checkoutTone}>{safeStr(r.status).toUpperCase()}</s-badge>\n                                    {r.callOutcome ? <s-badge tone={outcomeTone}>{outcomeLabel(r.callOutcome)}</s-badge> : null}\n                                    {r.offerCode ? <s-badge tone="success">{`CODE ${r.offerCode}`}</s-badge> : null}\n                                  </s-stack>\n                                  {r.offerPercent ? <s-text tone="subdued" variant="bodySm">{`${r.offerPercent}% offer${r.smsSentAt ? " · SMS sent" : ""}`}</s-text> : null}\n                                </s-stack>'''
if old_status in s:
    s = s.replace(old_status, new_status, 1)

# Recovered orders: prevent customer/order text from visually running together.
recovered_cell = re.compile(r'''(<s-table-cell style=\{compactCell\}>\n\s*)(<s-link\n\s+id=\{`win-\$\{id\}`\}[\s\S]*?</s-link>\n\s*<s-text tone="subdued" variant="bodySm">\n\s*\{safeStr\(r\.recoveredOrderId\) \? `ORDER \$\{r\.recoveredOrderId\}` : "RECOVERED"\}\n\s*</s-text>)(\n\s*</s-table-cell>)''')
def wrap_recovered(m):
    return m.group(1) + '<s-stack gap="tight">\n' + m.group(2) + '\n                                </s-stack>' + m.group(3)
s, _ = recovered_cell.subn(wrap_recovered, s, count=1)

# Add offer/order merchant cards in the details panel before actions.
details_actions_marker = '''                        <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>\n                          <s-button\n                            variant="primary"'''
if 'Offer & SMS' not in s and details_actions_marker in s:
    merchant_cards = '''                        {selected.offerCode || selected.smsSentAt ? (\n                          <s-box border="base" borderRadius="base" padding="base" background="subdued">\n                            <s-stack gap="tight">\n                              <s-text variant="headingSm">Offer & SMS</s-text>\n                              <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>\n                                {selected.offerCode ? <s-badge tone="success">{`Coupon ${selected.offerCode}`}</s-badge> : null}\n                                {selected.offerPercent ? <s-badge tone="info">{`${selected.offerPercent}% off`}</s-badge> : null}\n                                <s-badge tone={selected.smsSentAt ? "success" : "neutral"}>{selected.smsSentAt ? "SMS SENT" : "SMS NOT SENT"}</s-badge>\n                              </s-stack>\n                              {selected.smsSentAt ? <s-text tone="subdued" variant="bodySm">Sent {formatWhen(selected.smsSentAt)}</s-text> : null}\n                            </s-stack>\n                          </s-box>\n                        ) : null}\n\n                        {selected.recoveredOrderId ? (\n                          <s-box border="base" borderRadius="base" padding="base" style={{ background: "rgba(0,128,96,0.08)" }}>\n                            <s-stack gap="tight">\n                              <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>\n                                <s-badge tone="success">RECOVERED ORDER</s-badge>\n                                {selected.recoveredFinancial ? <s-badge tone="neutral">{safeStr(selected.recoveredFinancial).toUpperCase()}</s-badge> : null}\n                              </s-stack>\n                              <s-text fontWeight="semibold">{`Order ${selected.recoveredOrderId}`}</s-text>\n                              <s-text>{fmtMoney(Number(selected.recoveredAmount ?? 0), selected.currency)}</s-text>\n                            </s-stack>\n                          </s-box>\n                        ) : null}\n\n'''
    s = s.replace(details_actions_marker, merchant_cards + details_actions_marker, 1)

# Keep merchant-facing actions only; raw/evidence stay available in code but not primary UI.
s = re.sub(r'\n\s*<s-button variant="secondary" onClick=\{\(\) => setModalKind\("evidence"\)\}>\n\s*Evidence\n\s*</s-button>', '', s, count=1)
s = re.sub(r'\n\s*<s-button variant="secondary" onClick=\{\(\) => setModalKind\("raw"\)\}>\n\s*Raw\n\s*</s-button>', '', s, count=1)

p.write_text(s)
