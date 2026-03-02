import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateThread, getMessages } from "../lib/support.server";

function jsonResponse(data: any, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);

    const shop = String(session.shop ?? "").trim();
    if (!shop) {
      return jsonResponse({ ok: false, error: "Unauthorized", thread: null, messages: [] }, { status: 401 });
    }

    const thread = await getOrCreateThread(shop);
    const messages = await getMessages(thread.id, 200);

    return jsonResponse({ ok: true, thread, messages });
  } catch (error) {
    console.error("[api.support.thread]", error);
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : "Internal server error", thread: null, messages: [] },
      { status: 500 }
    );
  }
}