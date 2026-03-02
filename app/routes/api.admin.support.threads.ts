import type { LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { isPlatformAdminEmail, listThreads } from "../lib/support.server";

const PLATFORM_ADMIN_SHOP = String(process.env.PLATFORM_ADMIN_SHOP ?? "afterwin.myshopify.com").trim();

const { session } = await authenticate.admin(request);
const shop = String(session.shop ?? "").trim();
const ok = isPlatformAdminEmail(session.email ?? null) && shop === PLATFORM_ADMIN_SHOP;
if (!ok) return new Response("Not Found", { status: 404 });

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);

    if (!isPlatformAdminEmail(session.email ?? null)) {
      return json({ ok: false, error: "Not found", threads: [] }, { status: 404 });
    }

    const threads = await listThreads(200);

    return json({
      ok: true,
      threads,
    });
  } catch (error) {
    console.error("[api.admin.support.threads]", error);

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
        threads: [],
      },
      { status: 500 }
    );
  }
}