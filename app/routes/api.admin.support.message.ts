import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { insertMessage, supportChannelForShop } from "../lib/support.server";
import { supabaseAdmin } from "../lib/supabase.server";

const PLATFORM_ADMIN_SHOP = String(process.env.PLATFORM_ADMIN_SHOP ?? "afterwin.myshopify.com").trim();

function jsonResponse(data: any, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const viewerShop = String(session.shop ?? "").trim();

    if (viewerShop !== PLATFORM_ADMIN_SHOP) {
      return new Response("Not Found", { status: 404 });
    }

    const payload = (await request.json().catch(() => null)) as
      | { threadId?: string; body?: string }
      | null;

    const threadId = String(payload?.threadId ?? "").trim();
    const body = String(payload?.body ?? "").trim();

    if (!threadId || !body) {
      return jsonResponse({ ok: false, error: "Missing threadId or body" }, { status: 400 });
    }

    const message = await insertMessage({
      threadId,
      role: "admin",
      name: session.email ?? "admin",
      body,
    });

    const sb = supabaseAdmin();

    const threadRes = await sb.from("support_threads").select("shop").eq("id", threadId).single();
    if (threadRes.error) throw threadRes.error;

    const shop = String(threadRes.data.shop ?? "").trim();

    // realtime best-effort
    try {
      await sb.channel(supportChannelForShop(shop)).send({
        type: "broadcast",
        event: "support:new_message",
        payload: { threadId, message, shop },
      });

      await sb.channel("support-admin-global").send({
        type: "broadcast",
        event: "support:new_message",
        payload: { threadId, message, shop },
      });
    } catch (e) {
      console.error("[api.admin.support.message] broadcast skipped", e);
    }

    return jsonResponse({ ok: true, message });
  } catch (error) {
    console.error("[api.admin.support.message]", error);
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}