// app/lib/twilioSms.server.ts
import twilio from "twilio";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const client = twilio(requiredEnv("TWILIO_ACCOUNT_SID"), requiredEnv("TWILIO_AUTH_TOKEN"));

function normalizePhoneE164(raw: any): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let s = input.replace(/^tel:/i, "").trim();

  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("011")) s = "+" + s.slice(3);

  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }

  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits; // US/CA
  if (digits.length === 10 && (digits.startsWith("69") || digits.startsWith("2"))) return "+30" + digits; // GR
  if (digits.length === 10 && digits.startsWith("0") && (digits[1] === "6" || digits[1] === "2"))
    return "+30" + digits.slice(1);

  if (digits.length >= 11 && digits.length <= 15) return "+" + digits;

  return null;
}

export async function sendDiscountSms(args: { to: string; code: string; checkoutUrl: string }) {
  const { to, code, checkoutUrl } = args;

  const toE164 = normalizePhoneE164(to);
  if (!toE164) throw new Error(`Invalid recipient phone. E.164 required. Got: ${String(to ?? "")}`);

  const msg = await client.messages.create({
    to: toE164,
    messagingServiceSid: requiredEnv("TWILIO_MESSAGING_SERVICE_SID"),
    body: `Κωδικός έκπτωσης: ${code}\nCheckout: ${checkoutUrl}`,
  });

  return { sid: msg.sid };
}