import type { LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { supportChannelForShop, isPlatformAdminEmail } from "../lib/support.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const email = session.email ?? null;

  return json({
    shop,
    channel: supportChannelForShop(shop),
    role: isPlatformAdminEmail(email) ? "platform_admin" : "merchant",
  });
}