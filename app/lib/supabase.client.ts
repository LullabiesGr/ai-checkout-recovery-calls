import { createClient } from "@supabase/supabase-js";

function readMeta(name: string) {
  if (typeof document === "undefined") return "";
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
}

export function supabaseBrowser() {
  const url = readMeta("supabase-url");
  const anon = readMeta("supabase-anon-key");
  if (!url || !anon) throw new Error("Missing supabase meta tags (supabase-url / supabase-anon-key).");
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
}