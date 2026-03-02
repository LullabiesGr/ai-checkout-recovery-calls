import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

function readMeta(name: string) {
  if (typeof document === "undefined") return "";
  return (
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? ""
  );
}

export function supabaseBrowser(): SupabaseClient | null {
  if (typeof document === "undefined") return null;
  if (browserClient) return browserClient;

  const url = readMeta("supabase-url");
  const anon = readMeta("supabase-anon-key");

  if (!url || !anon) {
    console.error("Missing supabase meta tags (supabase-url / supabase-anon-key).");
    return null;
  }

  browserClient = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });

  return browserClient;
}