import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { isPlatformAdminEmail, insertMessage, supportChannelForShop } from "../lib/support.server";
import { createClient } from "@supabase/supabase-js";

function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const email = session.email ?? null;
  if (!isPlatformAdminEmail(email)) return json({ ok: false }, { status: 404 });

  const j = await request.json().catch(() => null) as { threadId?: string; body?: string } | null;
  const threadId = String(j?.threadId ?? "");
  const body = String(j?.body ?? "").trim();
  if (!threadId || !body) return json({ ok: false }, { status: 400 });

  const msg = await insertMessage({
    threadId,
    role: "admin",
    name: email ?? "admin",
    body,
  });

  // Broadcast to shop-specific channel is handled by a second broadcast:
  // we need the shop name. We’ll fetch it via Supabase.
  const sb = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const threadRes = await sb.from("support_threads").select("shop").eq("id", threadId).single();
  if (threadRes.error) throw threadRes.error;

  const shop = threadRes.data.shop as string;

  // 1) shop channel: merchant bubble
  await sb.channel(supportChannelForShop(shop)).send({
    type: "broadcast",
    event: "support:new_message",
    payload: { threadId, message: msg, shop },
  });

  // 2) global admin channel: refresh inbox
  await sb.channel("support-admin-global").send({
    type: "broadcast",
    event: "support:new_message",
    payload: { threadId, message: msg, shop },
  });

  return json({ ok: true, message: msg });
}