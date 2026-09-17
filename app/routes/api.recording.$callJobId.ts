import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchSupabaseSummaries, pickRecordingUrl } from "../lib/callInsights.server";

const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

function allowedRecordingUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;

    const configuredSupabaseHost = (() => {
      try { return new URL(process.env.SUPABASE_URL || "").hostname; } catch { return ""; }
    })();
    const host = url.hostname.toLowerCase();
    const allowed =
      host === "storage.vapi.ai" ||
      host.endsWith(".vapi.ai") ||
      host.endsWith(".r2.cloudflarestorage.com") ||
      (!!configuredSupabaseHost && host === configuredSupabaseHost);
    return allowed ? url : null;
  } catch {
    return null;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const callJobId = String(params.callJobId ?? "").trim();
  if (!callJobId) return new Response("Missing call", { status: 400 });

  const job = await db.callJob.findFirst({
    where: { id: callJobId, shop: session.shop },
    select: { id: true, checkoutId: true, providerCallId: true, recordingUrl: true },
  });
  if (!job) return new Response("Recording not found", { status: 404 });

  let recordingUrl = job.recordingUrl ? String(job.recordingUrl) : "";
  if (!recordingUrl) {
    const summaries = await fetchSupabaseSummaries({
      shop: session.shop,
      callIds: job.providerCallId ? [String(job.providerCallId)] : [],
      callJobIds: [job.id],
      checkoutIds: [job.checkoutId],
    });
    const summary =
      (job.providerCallId ? summaries.get(`call:${job.providerCallId}`) : null) ||
      summaries.get(`job:${job.id}`) ||
      summaries.get(`co:${job.checkoutId}`) ||
      null;
    recordingUrl = pickRecordingUrl(summary as any) || "";
  }

  const upstreamUrl = allowedRecordingUrl(recordingUrl);
  if (!upstreamUrl) return new Response("Recording unavailable", { status: 404 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "audio/*,application/octet-stream;q=0.9" },
    });
    if (!upstream.ok || !upstream.body) return new Response("Recording unavailable", { status: 502 });

    const size = Number(upstream.headers.get("content-length") || 0);
    if (size > MAX_RECORDING_BYTES) return new Response("Recording is too large", { status: 413 });

    const contentType = upstream.headers.get("content-type") || "audio/mpeg";
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        ...(size > 0 ? { "Content-Length": String(size) } : {}),
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Recording unavailable", { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
