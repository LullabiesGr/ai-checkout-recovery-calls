import type { LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { supportChannelForShop, isPlatformAdminEmail } from "../lib/support.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const email = session.email ?? null;

    return json({
      ok: true,
      shop,
      channel: supportChannelForShop(shop),
      role: isPlatformAdminEmail(email) ? "platform_admin" : "merchant",
    });
  } catch (error) {
    console.error("[api.support.channel]", error);

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
        channel: "",
      },
      { status: 500 }
    );
  }
}