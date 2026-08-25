import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

function safeJson(raw: string | null | undefined): any {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function recoveryUrlFromRaw(raw: string | null | undefined): string | null {
  const j = safeJson(raw);
  const value =
    j?.abandonedCheckoutUrl ??
    j?.abandoned_checkout_url ??
    j?.recoveryUrl ??
    j?.recovery_url ??
    null;
  const out = String(value ?? "").trim();
  return out.startsWith("http://") || out.startsWith("https://") ? out : null;
}

function offerCodeFromAnalysis(raw: string | null | undefined): string | null {
  const j = safeJson(raw);
  const out = String(j?.offer?.offerCode ?? "").trim();
  return out || null;
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const callJobId = String(params.callJobId ?? "").trim();
  if (!callJobId) return new Response("Not found", { status: 404 });

  const job = await db.callJob.findUnique({
    where: { id: callJobId },
    select: { shop: true, checkoutId: true, analysisJson: true },
  });
  if (!job) return new Response("Not found", { status: 404 });

  const checkout = await db.checkout.findFirst({
    where: { shop: job.shop, checkoutId: job.checkoutId },
    select: { raw: true },
  });
  const recoveryUrl = recoveryUrlFromRaw(checkout?.raw ?? null);
  if (!recoveryUrl) return new Response("Recovery link unavailable", { status: 404 });

  const incoming = new URL(request.url);
  const queryCode = String(incoming.searchParams.get("c") ?? "").trim();
  const code = queryCode || offerCodeFromAnalysis(job.analysisJson ?? null);

  const target = new URL(recoveryUrl);
  if (code) target.searchParams.set("discount", code);

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}
