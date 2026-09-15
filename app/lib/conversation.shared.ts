// Older calls included internal instructions as an initial user turn.
function spokenText(value: string): string {
  return value.split(/(?=^(?:User|Customer|AI|Agent|Assistant|Bot|System|Tool):)/mi).map(part => {
    const text = part.trim();
    if (/^(?:System|Tool):/i.test(text)) return "";
    const body = text.replace(/^(?:User|Customer):\s*/i, "");
    if (/^(?:There is no pre-created code yet\.|If the customer wants the link or code by SMS|When the customer clearly accepts receiving the SMS|Start the call now in English\.|Follow-up call\. Reference previous context|CALL FACTS\b)/i.test(body)) {
      // Some old transcripts concatenate actual speech onto the opening prompt.
      const end = body.match(/(?:continue entirely in that language\.|Keep it short and move to a concrete next step\.)([\s\S]*)$/i);
      const remainder = end?.[1]?.trim();
      return remainder ? `Customer: ${remainder}` : "";
    }
    return text;
  }).filter(Boolean).join("\n\n");
}

/** Extract only spoken dialogue; never expose system prompts or tool messages. */
export function conversationText(...sources: unknown[]): string {
  function extract(value: unknown, depth = 0): string {
    if (depth > 6 || value == null) return "";
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return "";
      if (/^[\[{]/.test(text)) { try { return extract(JSON.parse(text), depth + 1); } catch { return spokenText(text); } }
      return spokenText(text);
    }
    if (Array.isArray(value)) return value.map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const msg = entry as Record<string, unknown>;
      const role = String(msg.role ?? "").toLowerCase();
      if (!["user", "customer", "assistant", "bot", "agent"].includes(role)) return "";
      const text = typeof msg.message === "string" ? msg.message : typeof msg.content === "string" ? msg.content : "";
      const spoken = spokenText(text);
      return spoken.trim() ? `${role === "user" || role === "customer" ? "Customer" : "Agent"}: ${spoken.trim()}` : "";
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
