import type { LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateThread, getMessages } from "../lib/support.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const thread = await getOrCreateThread(session.shop);
    const messages = await getMessages(thread.id, 200);

    return json({
      ok: true,
      thread,
      messages,
    });
  } catch (error) {
    console.error("[api.support.thread]", error);

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error",
        thread: null,
        messages: [],
      },
      { status: 500 }
    );
  }
}