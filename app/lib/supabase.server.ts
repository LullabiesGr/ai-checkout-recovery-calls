import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | null = null;

function required(name: string) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

export function supabaseAdmin(): SupabaseClient {
  if (adminClient) return adminClient;

  adminClient = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return adminClient;
}