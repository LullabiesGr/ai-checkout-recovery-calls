// app/routes/api.apply-billing.ts
import type { ActionFunctionArgs } from "react-router";
import { applyBillingForCall } from "../lib/billing.server";

function bad(status: number, msg: string) {
  return new Response(msg, { status });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return bad(405, "Method not allowed");

  const expected = process.env.INTERNAL_API_SECRET ?? "";
  const got = request.headers.get("x-internal-secret") ?? "";
  if (!expected || got !== expected) return bad(401, "Unauthorized");

  const body = await request.json().catch(() => null);
  if (!body) return bad(400, "Bad JSON");

  const shop = String(body.shop ?? "").trim();
  const callJobId = String(body.callJobId ?? "").trim();
  const connectedSeconds = Number(body.connectedSeconds ?? 0);
  const answered = Boolean(body.answered);
  const voicemail = Boolean(body.voicemail);

  if (!shop || !callJobId) return bad(400, "Missing shop/callJobId");

  await applyBillingForCall({
    shop,
    callJobId,
    connectedSeconds,
    answered,
    voicemail,
  });

  return new Response("ok", { status: 200 });
}