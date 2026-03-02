import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getMessages, markRead } from "../lib/support.server";

const PLATFORM_ADMIN_SHOP = String(process.env.PLATFORM_ADMIN_SHOP ?? "afterwin.myshopify.com").trim();

function jsonResponse(data: any, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const shop = String(session.shop ?? "").trim();

    if (shop !== PLATFORM_ADMIN_SHOP) {
      return new Response("Not Found", { status: 404 });
    }

    const id = String(params.id ?? "").trim();
    if (!id) {
      return jsonResponse({ ok: false, error: "Missing thread id", messages: [] }, { status: 400 });
    }

    const messages = await getMessages(id, 400);
    await markRead(id, "admin");

    return jsonResponse({ ok: true, messages });
  } catch (error) {
    console.error("[api.admin.support.thread.$id]", error);
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
        messages: [],
      },
      { status: 500 },
    );
  }
}