import * as React from "react";
import { Card, Text, InlineStack, BlockStack, TextField, Button, Badge, Spinner } from "@shopify/polaris";
import { supabaseBrowser } from "../lib/supabase.client";

type Thread = { id: string; shop: string; status: string; unread_by_merchant: number };
type Msg = {
  id: string;
  thread_id: string;
  sender_role: string;
  sender_name: string | null;
  body: string;
  created_at: string;
};

export function SupportBubble({ shop }: { shop: string }) {
  const [open, setOpen] = React.useState(false);
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [messages, setMessages] = React.useState<Msg[] | null>(null);
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/support/thread");
      const j = await r.json();
      setThread(j.thread ?? null);
      setMessages(j.messages ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { if (open) load(); }, [open, load]);

  // Subscribe to shop channel once (only when bubble opens)
  React.useEffect(() => {
    if (!open) return;

    let active = true;
    const sb = supabaseBrowser();

    (async () => {
      const r = await fetch("/api/support/channel");
      const j = await r.json();
      const channelName = String(j?.channel ?? "");
      if (!channelName) return;

      const ch = sb.channel(channelName);

      ch.on("broadcast", { event: "support:new_message" }, (payload) => {
        if (!active) return;
        const p = (payload as any)?.payload;
        if (!p?.message) return;
        setMessages((prev) => (prev ? [...prev, p.message] : [p.message]));
      });

      ch.subscribe();

      return () => {
        sb.removeChannel(ch);
      };
    })();

    return () => { active = false; };
  }, [open]);

  const send = React.useCallback(async () => {
    const body = draft.trim();
    if (!body) return;

    setSending(true);
    try {
      const r = await fetch("/api/support/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const j = await r.json();
      if (j?.ok && j?.message) {
        setDraft("");
        setMessages((prev) => (prev ? [...prev, j.message] : [j.message]));
      }
    } finally {
      setSending(false);
    }
  }, [draft]);

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "fixed",
          right: 18,
          bottom: 18,
          width: 56,
          height: 56,
          borderRadius: 999,
          border: "1px solid rgba(0,0,0,0.12)",
          background: "#111827",
          color: "#fff",
          cursor: "pointer",
          zIndex: 2147482000,
        }}
        aria-label="Support chat"
        title="Support"
      >
        {thread?.unread_by_merchant ? (
          <span
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              width: 18,
              height: 18,
              borderRadius: 999,
              background: "#ef4444",
              border: "2px solid #fff",
            }}
          />
        ) : null}
        ?
      </button>

      {open ? (
        <div style={{ position: "fixed", right: 18, bottom: 86, width: 360, zIndex: 2147482000 }}>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <BlockStack gap="050">
                  <Text as="h3" variant="headingMd">Support</Text>
                  <InlineStack gap="200">
                    <Badge tone="success">Live</Badge>
                    <Text as="p" variant="bodySm" tone="subdued">{shop}</Text>
                  </InlineStack>
                </BlockStack>
                <Button onClick={() => setOpen(false)}>Close</Button>
              </InlineStack>

              <div style={{ height: 340, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
                {loading || !messages ? (
                  <InlineStack align="center"><Spinner accessibilityLabel="Loading" size="small" /></InlineStack>
                ) : messages.length === 0 ? (
                  <Text as="p" variant="bodyMd">Write your first message.</Text>
                ) : (
                  <BlockStack gap="200">
                    {messages.map((m) => (
                      <div key={m.id} style={{ padding: 10, borderRadius: 12, background: m.sender_role === "admin" ? "#eef2ff" : "#f9fafb" }}>
                        <InlineStack align="space-between">
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            {m.sender_role === "admin" ? "Support" : "You"}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">{new Date(m.created_at).toLocaleTimeString()}</Text>
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
                    label="Message"
                    labelHidden
                    value={draft}
                    onChange={setDraft}
                    autoComplete="off"
                    multiline={3}
                  />
                </div>
                <Button variant="primary" onClick={send} loading={sending}>Send</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </div>
      ) : null}
    </>
  );
}