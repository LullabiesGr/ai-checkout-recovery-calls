import type { ActionFunctionArgs } from "react-router";
import { assertSmsFeature } from "../lib/planFeatures.server";
import { sendManualCheckoutSms } from "../callProvider.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ success: false, error: "method_not_allowed" }, 405);
  }

  const secret = request.headers.get("x-internal-secret");
  if (secret !== requiredEnv("INTERNAL_API_SECRET")) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return json({ success: false, error: "bad_json" }, 400);
  }

  const shop = String(body.shop ?? "").trim();
  const checkoutId = String(body.checkoutId ?? "").trim();
  const requestId = String(body.requestId ?? request.headers.get("x-idempotency-key") ?? "").trim();

  if (!shop || !checkoutId || !requestId) {
    return json({ success: false, error: "missing_required_fields" }, 400);
  }

  try {
    const { plan } = await assertSmsFeature(shop);

    const sent = await sendManualCheckoutSms({ shop, checkoutId, requestId });

    return json({
      success: true,
      ...sent,
      plan,
    });
  } catch (e: any) {
    const status = Number(e?.status) || 500;
    return json(
      {
        success: false,
        error: e?.code || "sms_send_failed",
        message: e?.message || "SMS send failed",
        plan: e?.plan || null,
      },
      status
    );
  }
}
