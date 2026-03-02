import * as React from "react";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  Page,
  Card,
  Text,
  InlineStack,
  BlockStack,
  Divider,
  Badge,
  Button,
  TextField,
  Spinner,
} from "@shopify/polaris";
import { supabaseBrowser } from "../lib/supabase.client";

const PLATFORM_ADMIN_SHOP = String(process.env.PLATFORM_ADMIN_SHOP ?? "afterwin.myshopify.com").trim();

type Thread = {
  id: string;
  shop: string;
  status: string;
  unread_by_admin: number;
  last_message_at: string;
};

type Msg = {
  id: string;
  thread_id: string;
  sender_role: string;
  sender_name: string | null;
  body: string;
  created_at: string;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = String(session.shop ?? "").trim();

  if (shop !== PLATFORM_ADMIN_SHOP) throw new Response("Not Found", { status: 404 });

  return { viewerShop: shop, viewerEmail: session.email ?? null };
}

async function readJsonSafe<T = any>(res: Response): Promise<T | null> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export default function AdminSupportInbox() {
  const { viewerShop, viewerEmail } = useLoaderData<typeof loader>();

  // IMPORTANT: ΟΛΑ τα hooks δηλώνονται ΠΑΝΤΑ, σε κάθε render.
  const [mounted, setMounted] = React.useState(false);

  const [threads, setThreads] = React.useState<Thread[] | null>(null);
  const [active, setActive] = React.useState<Thread | null>(null);
  const [messages, setMessages] = React.useState<Msg[] | null>(null);

  const [draft, setDraft] = React.useState("");
  const [loadingThreads, setLoadingThreads] = React.useState(false);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const [threadsError, setThreadsError] = React.useState<string | null>(null);
  const [messagesError, setMessagesError] = React.useState<string | null>(null);

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const scrollToBottom = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const loadThreads = React.useCallback(async () => {
    setLoadingThreads(true);
    setThreadsError(null);

    try {
      const r = await fetch("/api/admin/support/threads");
      const j = await readJsonSafe<{ ok?: boolean; threads?: Thread[]; error?: string }>(r);

      if (!r.ok || j?.ok === false) {
        setThreads([]);
        setThreadsError(j?.error ?? r.statusText ?? "Failed to load threads");
        return;
      }

      const list = Array.isArray(j?.threads) ? j!.threads : [];
      setThreads(list);

      setActive((prev) => {
        if (prev && list.some((t) => t.id === prev.id)) return prev;
        return list[0] ?? null;
      });
    } catch (e) {
      setThreads([]);
      setThreadsError(e instanceof Error ? e.message : "Failed to load threads");
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  const loadThread = React.useCallback(
    async (threadId: string) => {
      setLoadingMessages(true);
      setMessagesError(null);

      try {
        const r = await fetch(`/api/admin/support/thread/${threadId}`);
        const j = await readJsonSafe<{ ok?: boolean; messages?: Msg[]; error?: string }>(r);

        if (!r.ok || j?.ok === false) {
          setMessages([]);
          setMessagesError(j?.error ?? r.statusText ?? "Failed to load thread");
          return;
        }

        const list = Array.isArray(j?.messages) ? j!.messages : [];
        setMessages(list);
        requestAnimationFrame(() => scrollToBottom());
      } catch (e) {
        setMessages([]);
        setMessagesError(e instanceof Error ? e.message : "Failed to load thread");
      } finally {
        setLoadingMessages(false);
      }
    },
    [scrollToBottom],
  );

  React.useEffect(() => {
    if (!mounted) return;
    void loadThreads();
  }, [mounted, loadThreads]);

  React.useEffect(() => {
    if (!mounted) return;
    if (!active?.id) return;
    void loadThread(active.id);
  }, [mounted, active?.id, loadThread]);

  React.useEffect(() => {
    if (!mounted) return;

    const sb = supabaseBrowser();
    if (!sb) return;

    const channel = sb.channel("support-admin-global");

    channel.on("broadcast", { event: "support:new_message" }, (payload) => {
      const p = (payload as any)?.payload;
      if (!p?.threadId || !p?.message) return;

      void loadThreads();

      setMessages((prev) => {
        if (!active?.id) return prev;
        if (active.id !== p.threadId) return prev;

        const current = prev ?? [];
        if (current.some((m) => m.id === p.message.id)) return current;

        const next = [...current, p.message];
        requestAnimationFrame(() => scrollToBottom());
        return next;
      });
    });

    channel.subscribe();

    return () => {
      sb.removeChannel(channel);
    };
  }, [mounted, active?.id, loadThreads, scrollToBottom]);

  const send = React.useCallback(async () => {
    if (!active?.id) return;

    const body = draft.trim();
    if (!body) return;

    setSending(true);
    try {
      const r = await fetch("/api/admin/support/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: active.id, body }),
      });

      const j = await readJsonSafe<{ ok?: boolean; message?: Msg; error?: string }>(r);

      if (!r.ok || j?.ok === false) {
        setMessagesError(j?.error ?? r.statusText ?? "Send failed");
        return;
      }

      if (j?.message) {
        setDraft("");
        setMessages((prev) => (prev ? [...prev, j.message!] : [j.message!]));
        requestAnimationFrame(() => scrollToBottom());
        void loadThreads();
      }
    } finally {
      setSending(false);
    }
  }, [active?.id, draft, loadThreads, scrollToBottom]);

  const left = (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">
              Support Inbox
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {viewerEmail ?? "admin"} • {viewerShop}
            </Text>
          </BlockStack>
          <Button onClick={loadThreads} loading={loadingThreads}>
            Refresh
          </Button>
        </InlineStack>

        <Divider />

        {threadsError ? (
          <Text as="p" variant="bodyMd" tone="critical">
            {threadsError}
          </Text>
        ) : null}

        {!threads ? (
          <InlineStack align="center">
            <Spinner accessibilityLabel="Loading threads" size="small" />
          </InlineStack>
        ) : threads.length === 0 ? (
          <Text as="p" variant="bodyMd">
            No conversations.
          </Text>
        ) : (
          <BlockStack gap="200">
            {threads.map((t) => {
              const selected = active?.id === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setActive(t)}
                  style={{
                    textAlign: "left",
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: 10,
                    background: selected ? "#f3f4f6" : "#fff",
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {t.shop}
                    </Text>
                    {t.unread_by_admin > 0 ? (
                      <Badge tone="attention">{t.unread_by_admin}</Badge>
                    ) : (
                      <Badge>{t.status}</Badge>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {new Date(t.last_message_at).toLocaleString()}
                  </Text>
                </button>
              );
            })}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );

  const right = (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">
              {active ? active.shop : "Select a conversation"}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {active ? `Thread: ${active.id}` : "Pick a thread on the left to reply."}
            </Text>
          </BlockStack>
        </InlineStack>

        <Divider />

        {messagesError ? (
          <Text as="p" variant="bodyMd" tone="critical">
            {messagesError}
          </Text>
        ) : null}

        <div
          ref={scrollerRef}
          style={{
            height: 420,
            overflow: "auto",
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            background: "#fff",
          }}
        >
          {!active ? (
            <Text as="p" variant="bodyMd">
              Pick a thread.
            </Text>
          ) : loadingMessages || messages === null ? (
            <InlineStack align="center">
              <Spinner accessibilityLabel="Loading messages" size="small" />
            </InlineStack>
          ) : messages.length === 0 ? (
            <Text as="p" variant="bodyMd">
              No messages yet.
            </Text>
          ) : (
            <BlockStack gap="200">
              {messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    padding: 10,
                    borderRadius: 12,
                    background: m.sender_role === "admin" ? "#eef2ff" : "#f9fafb",
                  }}
                >
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {m.sender_role === "admin" ? "Admin" : m.sender_name ?? "Merchant"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {new Date(m.created_at).toLocaleString()}
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodyMd">
                    {m.body}
                  </Text>
                </div>
              ))}
            </BlockStack>
          )}
        </div>

        <InlineStack gap="200" align="end">
          <div style={{ flex: 1 }}>
            <TextField
              label="Reply"
              labelHidden
              value={draft}
              onChange={setDraft}
              autoComplete="off"
              multiline={3}
              disabled={!active}
            />
          </div>
          <Button variant="primary" onClick={send} loading={sending} disabled={!active || !draft.trim()}>
            Send
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );

  return mounted ? (
    <Page>
      <InlineStack gap="400" align="start">
        <div style={{ width: 360, flexShrink: 0 }}>{left}</div>
        <div style={{ flex: 1 }}>{right}</div>
      </InlineStack>
    </Page>
  ) : null;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);