import * as React from "react";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { isPlatformAdminEmail } from "../lib/support.server";
import { Page, Card, Text, InlineStack, BlockStack, Divider, Badge, Button, TextField, Spinner } from "@shopify/polaris";
import { supabaseBrowser } from "../lib/supabase.client";

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
  const ok = isPlatformAdminEmail(session.email ?? null);
  if (!ok) throw new Response("Not Found", { status: 404 });
  return { shop: session.shop };
}

export default function AdminSupportInbox() {
  const { shop } = useLoaderData<typeof loader>();

  const [threads, setThreads] = React.useState<Thread[] | null>(null);
  const [active, setActive] = React.useState<Thread | null>(null);
  const [messages, setMessages] = React.useState<Msg[] | null>(null);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);

  const loadThreads = React.useCallback(async () => {
    const r = await fetch("/api/admin/support/threads");
    const j = await r.json();
    setThreads(j.threads ?? []);
    if (!active && (j.threads?.[0])) setActive(j.threads[0]);
  }, [active]);

  const loadThread = React.useCallback(async (threadId: string) => {
    const r = await fetch(`/api/admin/support/thread/${threadId}`);
    const j = await r.json();
    setMessages(j.messages ?? []);
  }, []);

  React.useEffect(() => { loadThreads(); }, [loadThreads]);
  React.useEffect(() => { if (active?.id) loadThread(active.id); }, [active?.id, loadThread]);

  // Realtime: subscribe to ALL threads via broadcast (we’ll receive shop + threadId)
  React.useEffect(() => {
    const sb = supabaseBrowser();
    const channel = sb.channel(`support-admin-global`);

    channel.on("broadcast", { event: "support:new_message" }, (payload) => {
      const p = (payload as any)?.payload;
      if (!p?.threadId || !p?.message) return;

      // refresh threads list + active thread messages
      loadThreads();
      if (active?.id === p.threadId) {
        setMessages((prev) => prev ? [...prev, p.message] : [p.message]);
      }
    });

    channel.subscribe();

    return () => { sb.removeChannel(channel); };
  }, [active?.id, loadThreads]);

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
      const j = await r.json();
      if (j?.ok && j?.message) {
        setDraft("");
        setMessages((prev) => prev ? [...prev, j.message] : [j.message]);
        loadThreads();
      }
    } finally {
      setSending(false);
    }
  }, [active?.id, draft, loadThreads]);

  const left = (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">Support Inbox</Text>
          <Button onClick={loadThreads}>Refresh</Button>
        </InlineStack>
        <Divider />
        {!threads ? (
          <InlineStack align="center"><Spinner accessibilityLabel="Loading threads" size="small" /></InlineStack>
        ) : threads.length === 0 ? (
          <Text as="p" variant="bodyMd">No conversations.</Text>
        ) : (
          <BlockStack gap="200">
            {threads.map((t) => (
              <button
                key={t.id}
                onClick={() => setActive(t)}
                style={{
                  textAlign: "left",
                  border: "1px solid #e5e7eb",
                  borderRadius: 12,
                  padding: 10,
                  background: active?.id === t.id ? "#f3f4f6" : "#fff",
                  cursor: "pointer",
                }}
              >
                <InlineStack align="space-between">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">{t.shop}</Text>
                  {t.unread_by_admin > 0 ? <Badge tone="attention">{t.unread_by_admin}</Badge> : <Badge>{t.status}</Badge>}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">{new Date(t.last_message_at).toLocaleString()}</Text>
              </button>
            ))}
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
            <Text as="h3" variant="headingMd">{active ? active.shop : "Select a conversation"}</Text>
            <Text as="p" variant="bodySm" tone="subdued">You are viewing from shop: {shop}</Text>
          </BlockStack>
        </InlineStack>

        <Divider />

        <div style={{ height: 420, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
          {!active ? (
            <Text as="p" variant="bodyMd">Pick a thread.</Text>
          ) : !messages ? (
            <InlineStack align="center"><Spinner accessibilityLabel="Loading messages" size="small" /></InlineStack>
          ) : messages.length === 0 ? (
            <Text as="p" variant="bodyMd">No messages yet.</Text>
          ) : (
            <BlockStack gap="200">
              {messages.map((m) => (
                <div key={m.id} style={{ padding: 10, borderRadius: 12, background: m.sender_role === "admin" ? "#eef2ff" : "#f9fafb" }}>
                  <InlineStack align="space-between">
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {m.sender_role === "admin" ? "Admin" : (m.sender_name ?? "Merchant")}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">{new Date(m.created_at).toLocaleString()}</Text>
                  </InlineStack>
                  <Text as="p" variant="bodyMd">{m.body}</Text>
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
            />
          </div>
          <Button variant="primary" onClick={send} loading={sending} disabled={!active}>Send</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );

  return (
    <Page>
      <InlineStack gap="400" align="start">
        <div style={{ width: 340, flexShrink: 0 }}>{left}</div>
        <div style={{ flex: 1 }}>{right}</div>
      </InlineStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);