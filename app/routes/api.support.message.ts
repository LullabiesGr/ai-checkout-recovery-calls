import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateThread, insertMessage, supportChannelForShop } from "../lib/support.server";
import { createClient } from "@supabase/supabase-js";

function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
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

    const channel = supportChannelForShop(shop);

    await sb.channel(channel).send({
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