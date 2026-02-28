// app/routes/api.vapi-tools.ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleVapiToolsWebhook } from "../callProvider.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function isAuthorized(request: Request) {
  const expected = (process.env.INTERNAL_API_SECRET ?? "").trim();
  const got = (request.headers.get("x-internal-secret") ?? "").trim();

  if (!expected) {
    return { ok: false, error: "Missing INTERNAL_API_SECRET" };
  }

  if (!got || got !== expected) {
    return { ok: false, error: "Unauthorized" };
  }

  return { ok: true };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const auth = isAuthorized(request);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, auth.error === "Missing INTERNAL_API_SECRET" ? 500 : 401);
  }

  return handleVapiToolsWebhook(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = isAuthorized(request);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, auth.error === "Missing INTERNAL_API_SECRET" ? 500 : 401);
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
}