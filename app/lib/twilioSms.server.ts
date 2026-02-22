import twilio from "twilio";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const client = twilio(requiredEnv("TWILIO_ACCOUNT_SID"), requiredEnv("TWILIO_AUTH_TOKEN"));

export async function sendDiscountSms(args: { to: string; code: string; checkoutUrl: string }) {
  const { to, code, checkoutUrl } = args;

  const msg = await client.messages.create({
    to,
    messagingServiceSid: requiredEnv("TWILIO_MESSAGING_SERVICE_SID"),
    body: `Κωδικός έκπτωσης: ${code}\nCheckout: ${checkoutUrl}`,
  });

  return { sid: msg.sid };
}