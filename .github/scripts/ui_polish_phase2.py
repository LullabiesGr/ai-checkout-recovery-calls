from pathlib import Path

# ---------------- Checkouts: make dashboard filter links actually work ----------------
p = Path('app/routes/app.checkouts.tsx')
s = p.read_text()

s = s.replace(
    'import { useFetcher, useLoaderData, useRouteError } from "react-router";',
    'import { useFetcher, useLoaderData, useLocation, useRouteError } from "react-router";'
)

s = s.replace(
    'type FilterKey = "all" | "abandoned" | "followups" | "high_intent" | "no_answer" | "discounts";',
    'type FilterKey = "all" | "open" | "abandoned" | "followups" | "high_intent" | "no_answer" | "discounts" | "recovered";'
)

old_component_start = '''export default function Checkouts() {\n  const { rows } = useLoaderData<typeof loader>();\n\n  const currency ='''
new_component_start = '''export default function Checkouts() {\n  const { rows } = useLoaderData<typeof loader>();\n  const location = useLocation();\n\n  const requestedFilter = React.useMemo<FilterKey>(() => {\n    const raw = new URLSearchParams(location.search).get("tab")?.toLowerCase() ?? "";\n    if (raw === "open" || raw === "abandoned" || raw === "followups" || raw === "high_intent" || raw === "no_answer" || raw === "discounts" || raw === "recovered") return raw as FilterKey;\n    return "all";\n  }, [location.search]);\n\n  const currency ='''
if old_component_start in s:
    s = s.replace(old_component_start, new_component_start, 1)

old_counts = '''    const c = {\n      all: baseWorkSorted.length,\n      abandoned: 0,\n      followups: 0,\n      high_intent: 0,\n      no_answer: 0,\n      discounts: 0,\n    };'''
new_counts = '''    const c = {\n      all: baseWorkSorted.length,\n      open: rows.filter((r) => safeStr(r.status).toUpperCase() === "OPEN" && !isRecovered(r)).length,\n      abandoned: 0,\n      followups: 0,\n      high_intent: 0,\n      no_answer: 0,\n      discounts: 0,\n      recovered: recoveredRows.length,\n    };'''
if old_counts in s:
    s = s.replace(old_counts, new_counts, 1)

s = s.replace(
    '  }, [baseWorkSorted]);\n\n  const [activeFilter, setActiveFilter] = React.useState<FilterKey>("all");',
    '  }, [baseWorkSorted, recoveredRows, rows]);\n\n  const [activeFilter, setActiveFilter] = React.useState<FilterKey>(requestedFilter);\n  React.useEffect(() => setActiveFilter(requestedFilter), [requestedFilter]);',
    1,
)

old_switch = '''    switch (activeFilter) {\n      case "abandoned":\n        return baseWorkSorted.filter((r) => r.eligibleAtRisk);'''
new_switch = '''    switch (activeFilter) {\n      case "open":\n        return rows.filter((r) => safeStr(r.status).toUpperCase() === "OPEN" && !isRecovered(r));\n      case "recovered":\n        return recoveredRows;\n      case "abandoned":\n        return baseWorkSorted.filter((r) => r.eligibleAtRisk);'''
if old_switch in s:
    s = s.replace(old_switch, new_switch, 1)

s = s.replace(
    '  }, [baseWorkSorted, activeFilter]);',
    '  }, [baseWorkSorted, activeFilter, recoveredRows, rows]);',
    1,
)

old_chips = '''                    <s-chip {...chipProps("all")}>All ({counts.all})</s-chip>\n                    <s-chip {...chipProps("abandoned")}>Abandoned ({counts.abandoned})</s-chip>'''
new_chips = '''                    <s-chip {...chipProps("all")}>All ({counts.all})</s-chip>\n                    {counts.open > 0 ? <s-chip {...chipProps("open")}>Open ({counts.open})</s-chip> : null}\n                    <s-chip {...chipProps("abandoned")}>Abandoned ({counts.abandoned})</s-chip>'''
if old_chips in s:
    s = s.replace(old_chips, new_chips, 1)

needle = '                    {hasDiscountFields ? <s-chip {...chipProps("discounts")}>Discounts ({counts.discounts})</s-chip> : null}\n'
if needle in s and 'chipProps("recovered")' not in s:
    s = s.replace(needle, needle + '                    {counts.recovered > 0 ? <s-chip {...chipProps("recovered")}>Recovered ({counts.recovered})</s-chip> : null}\n', 1)

p.write_text(s)

# ---------------- Dashboard: customer names, short IDs, human statuses ----------------
p = Path('app/routes/app.dashboard.tsx')
s = p.read_text()

marker = '  type LiveInternal = DashboardViewProps["liveRows"][number] & { ts: number };\n'
if marker in s and 'const customerByCheckoutId' not in s:
    insert = '''  const customerByCheckoutId = new Map(\n    recentCheckouts.map((c) => [String(c.checkoutId), String(c.customerName ?? "").trim()]).filter(([, name]) => Boolean(name)),\n  );\n\n  const shortCheckout = (id: string) => {\n    const value = String(id ?? "").trim();\n    return value.length > 12 ? `…${value.slice(-10)}` : value;\n  };\n\n'''
    s = s.replace(marker, insert + marker, 1)

s = s.replace(
    '    const event = `Call${cid ? ` • Checkout ${cid}` : ""}`;',
    '    const customer = cid ? customerByCheckoutId.get(cid) : "";\n    const event = customer ? `Call · ${customer}` : cid ? `Call · Checkout ${shortCheckout(cid)}` : "Call";',
    1,
)
s = s.replace(
    '    const event = `Job • Checkout ${String(j.checkoutId)}`;',
    '    const customer = customerByCheckoutId.get(String(j.checkoutId)) || "";\n    const event = customer ? `Call · ${customer}` : `Call · Checkout ${shortCheckout(String(j.checkoutId))}`;',
    1,
)
p.write_text(s)

# ---------------- Dashboard view: human status labels + order column ----------------
p = Path('app/components/dashboard/DashboardView.tsx')
s = p.read_text()

if 'function displayActivityStatus' not in s:
    helper_marker = 'function badgeTone(tone: BadgeTone) {'
    helper = '''function displayActivityStatus(value: string) {\n  const v = String(value ?? "").trim().toUpperCase();\n  const known: Record<string, string> = {\n    NEEDS_FOLLOWUP: "Needs follow-up",\n    ORDER_RECOVERED: "Order recovered",\n    HIGH_INTENT: "High intent",\n    NO_ANSWER: "No answer",\n    AI_ERROR: "Needs review",\n    NOT_RECOVERED: "Not recovered",\n    COMPLETED: "Completed",\n    CALLING: "Calling",\n    QUEUED: "Waiting",\n    FAILED: "Failed",\n    ERROR: "Needs review",\n    VOICEMAIL: "Voicemail",\n  };\n  return known[v] ?? (v ? v.replace(/_/g, " ").toLowerCase().replace(/\\b\\w/g, (m) => m.toUpperCase()) : "Update");\n}\n\n'''
    if helper_marker in s:
        s = s.replace(helper_marker, helper + helper_marker, 1)

s = s.replace(
    '<Badge tone={badgeTone(row.tone)}>{row.status}</Badge>',
    '<Badge tone={badgeTone(row.tone)}>{displayActivityStatus(row.status)}</Badge>',
    1,
)

old_recovery_when = '''      <IndexTable.Cell>\n        <Text as="span" variant="bodySm" tone="subdued">\n          {row.whenText}\n        </Text>\n      </IndexTable.Cell>\n    </IndexTable.Row>'''
new_recovery_when = '''      <IndexTable.Cell>\n        <Text as="span" variant="bodySm" tone="subdued">\n          {row.whenText}\n        </Text>\n      </IndexTable.Cell>\n      <IndexTable.Cell>\n        <Text as="span" variant="bodySm">{row.recoveredOrderId || "—"}</Text>\n      </IndexTable.Cell>\n    </IndexTable.Row>'''
# There are multiple similar fragments; target the one after recoveryRows declaration.
idx = s.find('const recoveryRows =')
if idx >= 0:
    tail = s[idx:]
    if old_recovery_when in tail and 'row.recoveredOrderId || "—"' not in tail.split('return (',1)[0]:
        tail = tail.replace(old_recovery_when, new_recovery_when, 1)
        s = s[:idx] + tail

s = s.replace(
    'headings={[{ title: "Customer" }, { title: "Recovered" }, { title: "When" }]}',
    'headings={[{ title: "Customer" }, { title: "Recovered" }, { title: "When" }, { title: "Order" }]}',
    1,
)
p.write_text(s)
