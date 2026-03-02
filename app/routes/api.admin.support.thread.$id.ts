import type { LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { isPlatformAdminEmail, getMessages, markRead } from "../lib/support.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  if (!isPlatformAdminEmail(session.email ?? null)) return json({ messages: [] }, { status: 404 });

  const id = String(params.id ?? "");
  if (!id) return json({ messages: [] }, { status: 400 });

  const messages = await getMessages(id, 400);
  await markRead(id, "admin");
  return json({ messages });
}