// app/lib/brevoSms.server.ts

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function pickApiKey() {
  return String(process.env.BREVO_API_KEY ?? process.env.BREVO_SMS_API_KEY ?? "").trim() || requiredEnv("BREVO_API_KEY");
}

function pickSender() {
  const s =
    String(
      process.env.BREVO_SMS_SENDER ??
        process.env.BREVO_SENDER ??
        process.env.VAPI_SMS_SENDER ??
        process.env.VAPI_SMS_FROM_NUMBER ??
        ""
    ).trim();

  if (!s) throw new Error("Missing env: BREVO_SMS_SENDER (or VAPI_SMS_SENDER/VAPI_SMS_FROM_NUMBER fallback)");
  return normalizeSender(s);
}

function normalizeRecipient(e164: string) {
  // Brevo examples use country code without "+"
  return String(e164 ?? "").trim().replace(/[^\d+]/g, "").replace(/^\+/, "");
}

function normalizeSender(sender: string) {
  const raw = String(sender ?? "").trim();
  if (!raw) return "";

  const digits = raw.replace(/[^\d+]/g, "").replace(/^\+/, "");
  const looksNumeric = digits.length >= 6 && /^\d+$/.test(digits);

  if (looksNumeric) {
    // numeric sender allowed up to 15 chars per docs
    return digits.slice(0, 15);
  }

  // alphanumeric sender: keep it short (docs: 11 for alphanumeric)
  return raw.slice(0, 11);
}

function normalizeType(t: string | null | undefined) {
  const v = String(t ?? "").trim().toLowerCase();
  if (v === "marketing") return "marketing";
  return "transactional";
}

export async function sendBrevoTransactionalSms(args: {
  toE164: string;
  content: string;
  tag?: string | null;
  type?: "transactional" | "marketing" | string | null;
  unicodeEnabled?: boolean;
  organisationPrefix?: string | null;
}) {
  const apiKey = pickApiKey();
  const sender = pickSender();

  const recipient = normalizeRecipient(args.toE164);
  if (!recipient) throw new Error("Invalid recipient phone");

  const payload: Record<string, any> = {
    sender,
    recipient,
    content: String(args.content ?? "").trim(),
    type: normalizeType(args.type ?? process.env.BREVO_SMS_TYPE),
  };

  const tag = String(args.tag ?? process.env.BREVO_SMS_TAG ?? "").trim();
  if (tag) payload.tag = tag;

  const organisationPrefix = String(
    args.organisationPrefix ?? process.env.BREVO_SMS_ORGANISATION_PREFIX ?? ""
  ).trim();
  if (organisationPrefix) payload.organisationPrefix = organisationPrefix;

  const unicodeEnabled =
    typeof args.unicodeEnabled === "boolean"
      ? args.unicodeEnabled
      : String(process.env.BREVO_SMS_UNICODE ?? "").trim().toLowerCase() === "true";
  if (unicodeEnabled) payload.unicodeEnabled = true;

  const r = await fetch("https://api.brevo.com/v3/transactionalSMS/send", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!r.ok) {
    throw new Error(`Brevo SMS failed HTTP ${r.status}: ${text.slice(0, 900)}`);
  }

  const messageId = String(data?.messageId ?? "").trim();
  return { messageId, raw: data };
}

export async function sendDiscountSms(args: { to: string; code: string; checkoutUrl: string }) {
  const content = `Your discount code: ${String(args.code).trim()}. Complete checkout: ${String(args.checkoutUrl).trim()}`;
  const { messageId } = await sendBrevoTransactionalSms({
    toE164: args.to,
    content,
    tag: "discount",
    type: process.env.BREVO_SMS_TYPE ?? "transactional",
  });
  return { messageId };
}