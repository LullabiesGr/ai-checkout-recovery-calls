import type { LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { isPlatformAdminEmail, listThreads } from "../lib/support.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  if (!isPlatformAdminEmail(session.email ?? null)) return json({ threads: [] }, { status: 404 });
  const threads = await listThreads(200);
  return json({ threads });
}