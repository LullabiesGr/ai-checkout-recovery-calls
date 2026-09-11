/** Extract only spoken dialogue; never expose system prompts or tool messages. */
export function conversationText(...sources: unknown[]): string {
  function extract(value: unknown, depth = 0): string {
    if (depth > 6 || value == null) return "";
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return "";
      if (/^[\[{]/.test(text)) { try { return extract(JSON.parse(text), depth + 1); } catch { return text; } }
      return text;
    }
    if (Array.isArray(value)) return value.map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const msg = entry as Record<string, unknown>;
      const role = String(msg.role ?? "").toLowerCase();
      if (!["user", "customer", "assistant", "bot", "agent"].includes(role)) return "";
      const text = typeof msg.message === "string" ? msg.message : typeof msg.content === "string" ? msg.content : "";
      return text.trim() ? `${role === "user" || role === "customer" ? "Customer" : "Agent"}: ${text.trim()}` : "";
    }).filter(Boolean).join("\n\n");
    if (typeof value !== "object") return "";
    const obj = value as Record<string, unknown>;
    for (const key of ["transcript", "messages", "artifact", "message", "end_of_call_report", "payload"]) {
      const text = extract(obj[key], depth + 1);
      if (text) return text;
    }
    return "";
  }
  for (const source of sources) { const text = extract(source); if (text) return text; }
  return "";
}

export function recoveryOutcome(value: unknown, hasOrder: boolean): string {
  if (hasOrder) return "recovered";
  const outcome = String(value ?? "").trim().toLowerCase().replace(/[ -]+/g, "_");
  return ["recovered", "order_recovered", "converted"].includes(outcome) ? "awaiting_order" : outcome;
}
