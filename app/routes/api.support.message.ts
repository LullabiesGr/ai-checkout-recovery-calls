import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateThread, insertMessage, supportChannelForShop } from "../lib/support.server";
import { createClient } from "@supabase/supabase-js";

function jsonResponse(data: any, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function required(name: string) {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);

    const shop = String(session.shop ?? "").trim();
    if (!shop) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const bodyJson = (await request.json().catch(() => null)) as { body?: string } | null;
    const body = String(bodyJson?.body ?? "").trim();

    if (!body) {
      return jsonResponse({ ok: false, error: "Empty message" }, { status: 400 });
    }

    const thread = await getOrCreateThread(shop);

    const message = await insertMessage({
      threadId: thread.id,
      role: "merchant",
      name: session.email ?? shop,
      body,
    });

    // Realtime broadcast: αν λείπει SERVICE ROLE ή URL, μην σκάσεις το send.
    try {
      const sb = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      await sb.channel(supportChannelForShop(shop)).send({
        type: "broadcast",
        event: "support:new_message",
        payload: { threadId: thread.id, message, shop },
      });

      await sb.channel("support-admin-global").send({
        type: "broadcast",
        event: "support:new_message",
        payload: { threadId: thread.id, message, shop },
      });
    } catch (e) {
      console.error("[api.support.message] broadcast skipped", e);
    }

    return jsonResponse({ ok: true, threadId: thread.id, message });
  } catch (error) {
    console.error("[api.support.message]", error);
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}