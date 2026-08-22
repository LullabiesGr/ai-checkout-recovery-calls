import "jsr:@supabase/functions-js/edge-runtime.d.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const incomingUrl = new URL(req.url);
  const secret = String(incomingUrl.searchParams.get("secret") ?? "").trim();
  if (!secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const rawBody = await req.text();
  if (!rawBody) {
    return json({ ok: false, error: "Bad Request" }, 400);
  }

  const target = `https://checkout-call-recovery-ai.onrender.com/webhooks/vapi?secret=${encodeURIComponent(secret)}`;

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": req.headers.get("content-type") || "application/json",
      },
      body: rawBody,
    });

    const responseBody = await upstream.text().catch(() => "");
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("[vapi-webhook] forward error", error);
    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
