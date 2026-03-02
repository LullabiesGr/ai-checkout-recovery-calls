import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supportChannelForShop, isPlatformAdminEmail } from "../lib/support.server";

function jsonResponse(data: any, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);

    const shop = String(session.shop ?? "").trim();
    const email = session.email ?? null;

    if (!shop) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    return jsonResponse({
      ok: true,
      shop,
      channel: supportChannelForShop(shop),
      role: isPlatformAdminEmail(email) ? "platform_admin" : "merchant",
    });
  } catch (error) {
    console.error("[api.support.channel]", error);
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : "Internal server error", channel: "" },
      { status: 500 }
    );
  }
}