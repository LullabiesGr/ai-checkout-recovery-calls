import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { listThreads } from "../lib/support.server";

const PLATFORM_ADMIN_SHOP = String(process.env.PLATFORM_ADMIN_SHOP ?? "afterwin.myshopify.com").trim();

function jsonResponse(data: any, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const shop = String(session.shop ?? "").trim();

    if (shop !== PLATFORM_ADMIN_SHOP) {
      return new Response("Not Found", { status: 404 });
    }

    const threads = await listThreads(200);

    return jsonResponse({ ok: true, threads });
  } catch (error) {
    console.error("[api.admin.support.threads]", error);
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
        threads: [],
      },
      { status: 500 },
    );
  }
}