import type { ActionFunctionArgs } from "react-router";
import { sendDiscountSms } from "../lib/twilioSms.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // απλό shared-secret για να μη μπορεί να το καλέσει τρίτος
  const secret = request.headers.get("x-internal-secret");
  if (secret !== requiredEnv("INTERNAL_API_SECRET")) {
    return new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const { to, code, checkoutUrl } = await request.json();

  const { sid } = await sendDiscountSms({ to, code, checkoutUrl });

  return new Response(JSON.stringify({ success: true, sid }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}