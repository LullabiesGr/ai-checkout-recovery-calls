import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { isPlatformAdminEmail, insertMessage, supportChannelForShop } from "../lib/support.server";
import { createClient } from "@supabase/supabase-js";

const PLATFORM_ADMIN_SHOP = String(process.env.PLATFORM_ADMIN_SHOP ?? "afterwin.myshopify.com").trim();

const { session } = await authenticate.admin(request);
const shop = String(session.shop ?? "").trim();
const ok = isPlatformAdminEmail(session.email ?? null) && shop === PLATFORM_ADMIN_SHOP;
if (!ok) return new Response("Not Found", { status: 404 });

function required(name: string) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const email = session.email ?? null;

    if (!isPlatformAdminEmail(email)) {
      return json({ ok: false, error: "Not found" }, { status: 404 });
    }

    const payload = (await request.json().catch(() => null)) as
      | { threadId?: string; body?: string }
      | null;

    const threadId = String(payload?.threadId ?? "").trim();
    const body = String(payload?.body ?? "").trim();

    if (!threadId || !body) {
      return json({ ok: false, error: "Missing threadId or body" }, { status: 400 });
    }

    const message = await insertMessage({
      threadId,
      role: "admin",
      name: email ?? "admin",
      body,
    });

    const sb = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const threadRes = await sb
      .from("support_threads")
      .select("shop")
      .eq("id", threadId)
      .single();

    if (threadRes.error) throw threadRes.error;

    const shop = String(threadRes.data.shop);

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

    return json({
      ok: true,
      message,
    });
  } catch (error) {
    console.error("[api.admin.support.message]", error);

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}