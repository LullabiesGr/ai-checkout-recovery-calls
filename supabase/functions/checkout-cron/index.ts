import "jsr:@supabase/functions-js/edge-runtime.d.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (_req: Request) => {
  const appCronUrl = String(Deno.env.get("APP_CRON_URL") ?? "").trim();
  const cronToken = String(Deno.env.get("CRON_TOKEN") ?? "").trim();

  if (!appCronUrl) {
    return json({ ok: false, error: "Missing APP_CRON_URL" }, 500);
  }

  try {
    const upstream = await fetch(appCronUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-token": cronToken,
      },
      body: JSON.stringify({ source: "supabase-schedule" }),
    });

    const text = await upstream.text().catch(() => "");
    let renderBody: unknown = text;
    try {
      renderBody = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text.
    }

    return json({
      ok: upstream.ok,
      renderStatus: upstream.status,
      renderBody,
    });
  } catch (error) {
    console.error("[checkout-cron] fetch error", error);
    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
