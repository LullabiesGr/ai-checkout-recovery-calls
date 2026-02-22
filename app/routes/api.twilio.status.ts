import type { ActionFunctionArgs } from "react-router";

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();

  const payload = Object.fromEntries(form.entries());
  // payload contains: MessageSid, MessageStatus, To, ErrorCode, ErrorMessage, etc.
  console.log("twilio-status", payload);

  return new Response("ok", { status: 200 });
}