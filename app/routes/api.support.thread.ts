import type { LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateThread, getMessages } from "../lib/support.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const thread = await getOrCreateThread(session.shop);
  const messages = await getMessages(thread.id, 200);
  return json({ thread, messages });
}