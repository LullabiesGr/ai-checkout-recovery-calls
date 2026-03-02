import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateThread, insertMessage, supportChannelForShop } from "../lib/support.server";
import { createClient } from "@supabase/supabase-js";

function required(name: string) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    const bodyJson = (await request.json().catch(() => null)) as { body?: string } | null;
    const body = String(bodyJson?.body ?? "").trim();

    if (!body) {
      return json({ ok: false, error: "Empty message" }, { status: 400 });
    }

    const thread = await getOrCreateThread(shop);

    const message = await insertMessage({
      threadId: thread.id,
      role: "merchant",
      name: session.email ?? shop,
      body,
    });

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

    return json({
      ok: true,
      threadId: thread.id,
      message,
    });
  } catch (error) {
    console.error("[api.support.message]", error);

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}