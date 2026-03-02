import crypto from "node:crypto";
import { supabaseAdmin } from "./supabase.server";

export function isPlatformAdminEmail(email?: string | null) {
  const raw = String(process.env.SUPPORT_ADMIN_EMAILS ?? "").trim();
  if (!raw) return false;

  const allow = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return !!email && allow.includes(String(email).trim().toLowerCase());
}

// Fallback αν λείπει SUPPORT_CHANNEL_SECRET: δεν σκάει το app, απλώς το channel είναι προβλέψιμο.
export function supportChannelForShop(shop: string) {
  const secret = String(process.env.SUPPORT_CHANNEL_SECRET ?? "").trim();
  if (!secret) return `support:${shop}`;
  const sig = crypto.createHmac("sha256", secret).update(shop).digest("hex").slice(0, 24);
  return `support:${shop}:${sig}`;
}

export async function getOrCreateThread(shop: string) {
  const sb = supabaseAdmin();

  const existing = await sb.from("support_threads").select("*").eq("shop", shop).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;

  const now = new Date().toISOString();

  const created = await sb
    .from("support_threads")
    .insert({
      shop,
      status: "open",
      unread_by_admin: 0,
      unread_by_merchant: 0,
      last_message_at: now,
    })
    .select("*")
    .single();

  if (created.error) throw created.error;
  return created.data;
}

export async function listThreads(limit = 200) {
  const sb = supabaseAdmin();
  const res = await sb.from("support_threads").select("*").order("last_message_at", { ascending: false }).limit(limit);
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

  const inserted = await sb
    .from("support_messages")
    .insert({
      thread_id: args.threadId,
      sender_role: args.role,
      sender_name: args.name ?? null,
      body: args.body,
    })
    .select("*")
    .single();

  if (inserted.error) throw inserted.error;

  const message = inserted.data;

  const threadRes = await sb
    .from("support_threads")
    .select("unread_by_admin, unread_by_merchant")
    .eq("id", args.threadId)
    .single();

  if (threadRes.error) throw threadRes.error;

  const currentAdminUnread = Number(threadRes.data.unread_by_admin ?? 0);
  const currentMerchantUnread = Number(threadRes.data.unread_by_merchant ?? 0);

  const patch =
    args.role === "admin"
      ? { unread_by_merchant: currentMerchantUnread + 1, last_message_at: message.created_at }
      : { unread_by_admin: currentAdminUnread + 1, last_message_at: message.created_at };

  const upd = await sb.from("support_threads").update(patch).eq("id", args.threadId);
  if (upd.error) throw upd.error;

  return message;
}

export async function markRead(threadId: string, side: "admin" | "merchant") {
  const sb = supabaseAdmin();
  const patch = side === "admin" ? { unread_by_admin: 0 } : { unread_by_merchant: 0 };
  const res = await sb.from("support_threads").update(patch).eq("id", threadId);
  if (res.error) throw res.error;
}