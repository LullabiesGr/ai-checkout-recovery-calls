import crypto from "node:crypto";
import { supabaseAdmin } from "./supabase.server";

function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function isPlatformAdminEmail(email?: string | null) {
  const raw = String(process.env.SUPPORT_ADMIN_EMAILS ?? "").trim();
  if (!raw) return false;
  const allow = raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!email && allow.includes(String(email).toLowerCase());
}

export function supportChannelForShop(shop: string) {
  const secret = required("SUPPORT_CHANNEL_SECRET");
  const sig = crypto.createHmac("sha256", secret).update(shop).digest("hex").slice(0, 24);
  return `support:${shop}:${sig}`;
}

export async function getOrCreateThread(shop: string) {
  const sb = supabaseAdmin();

  const existing = await sb
    .from("support_threads")
    .select("*")
    .eq("shop", shop)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;

  const created = await sb
    .from("support_threads")
    .insert({ shop, status: "open" })
    .select("*")
    .single();

  if (created.error) throw created.error;
  return created.data;
}

export async function listThreads(limit = 100) {
  const sb = supabaseAdmin();
  const res = await sb
    .from("support_threads")
    .select("*")
    .order("last_message_at", { ascending: false })
    .limit(limit);

  if (res.error) throw res.error;
  return res.data ?? [];
}

export async function getMessages(threadId: string, limit = 200) {
  const sb = supabaseAdmin();
  const res = await sb
    .from("support_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (res.error) throw res.error;
  return res.data ?? [];
}

export async function insertMessage(args: {
  threadId: string;
  role: "merchant" | "admin" | "system";
  name?: string | null;
  body: string;
}) {
  const sb = supabaseAdmin();
  const res = await sb
    .from("support_messages")
    .insert({
      thread_id: args.threadId,
      sender_role: args.role,
      sender_name: args.name ?? null,
      body: args.body,
    })
    .select("*")
    .single();

  if (res.error) throw res.error;
  return res.data;
}

export async function markRead(threadId: string, side: "admin" | "merchant") {
  const sb = supabaseAdmin();
  const patch =
    side === "admin"
      ? { unread_by_admin: 0 }
      : { unread_by_merchant: 0 };

  const res = await sb.from("support_threads").update(patch).eq("id", threadId);
  if (res.error) throw res.error;
}

export async function setThreadStatus(threadId: string, status: "open" | "closed" | "pending") {
  const sb = supabaseAdmin();
  const res = await sb.from("support_threads").update({ status }).eq("id", threadId);
  if (res.error) throw res.error;
}