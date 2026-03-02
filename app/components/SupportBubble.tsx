import * as React from "react";
import {
  Card,
  Text,
  InlineStack,
  BlockStack,
  TextField,
  Button,
  Badge,
  Spinner,
} from "@shopify/polaris";
import { supabaseBrowser } from "../lib/supabase.client";

type Thread = {
  id: string;
  shop: string;
  status: string;
  unread_by_merchant: number;
};

type Msg = {
  id: string;
  thread_id: string;
  sender_role: string;
  sender_name: string | null;
  body: string;
  created_at: string;
};

async function readJsonSafe<T = any>(response: Response): Promise<T | null> {
  const text = await response.text().catch(() => "");
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function SupportBubble({ shop }: { shop: string }) {
  const [open, setOpen] = React.useState(false);
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [messages, setMessages] = React.useState<Msg[] | null>(null);
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const appendMessage = React.useCallback((message: Msg) => {
    setMessages((prev) => {
      const current = prev ?? [];
      if (current.some((m) => m.id === message.id)) return current;
      return [...current, message];
    });
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);

    try {
      const response = await fetch("/api/support/thread");
      const payload = await readJsonSafe<{ ok?: boolean; thread?: Thread; messages?: Msg[]; error?: string }>(
        response
      );

      if (!response.ok || payload?.ok === false) {
        console.error("[support] thread load failed", payload?.error ?? response.statusText);
        setThread(null);
        setMessages([]);
        return;
      }

      setThread(payload?.thread ?? null);
      setMessages(Array.isArray(payload?.messages) ? payload!.messages : []);
    } catch (error) {
      console.error("[support] thread load failed", error);
      setThread(null);
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  React.useEffect(() => {
    if (!open) return;

    const sb = supabaseBrowser();
    if (!sb) return;

    let active = true;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        const response = await fetch("/api/support/channel");
        const payload = await readJsonSafe<{ ok?: boolean; channel?: string; error?: string }>(response);

        if (!active) return;
        if (!response.ok || payload?.ok === false) {
          console.error("[support] channel load failed", payload?.error ?? response.statusText);
          return;
        }

        const channelName = String(payload?.channel ?? "").trim();
        if (!channelName) return;

        const ch = sb.channel(channelName);

        ch.on("broadcast", { event: "support:new_message" }, (payload) => {
          if (!active) return;
          const message = (payload as any)?.payload?.message as Msg | undefined;
          if (!message?.id) return;
          appendMessage(message);
        });

        ch.subscribe();

        cleanup = () => {
          void sb.removeChannel(ch);
        };
      } catch (error) {
        console.error("[support] realtime subscription failed", error);
      }
    })();

    return () => {
      active = false;
      cleanup?.();
    };
  }, [open, appendMessage]);

  const send = React.useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);

    try {
      const response = await fetch("/api/support/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });

      const payload = await readJsonSafe<{ ok?: boolean; message?: Msg; error?: string }>(response);

      if (!response.ok || payload?.ok === false) {
        console.error("[support] send failed", payload?.error ?? response.statusText);
        return;
      }

      if (payload?.message) {
        setDraft("");
        appendMessage(payload.message);
      }
    } catch (error) {
      console.error("[support] send failed", error);
    } finally {
      setSending(false);
    }
  }, [appendMessage, draft, sending]);

  const unread = Number(thread?.unread_by_merchant ?? 0) > 0;

  return (
    <>
      <button
        type="button"
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
          fontSize: 20,
          fontWeight: 700,
        }}
        aria-label="Support chat"
        title="Support"
      >
        {unread ? (
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
        <div
          style={{
            position: "fixed",
            right: 18,
            bottom: 86,
            width: 360,
            zIndex: 2147482000,
          }}
        >
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <BlockStack gap="050">
                  <Text as="h3" variant="headingMd">
                    Support
                  </Text>

                  <InlineStack gap="200">
                    <Badge tone="success">Live</Badge>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {shop}
                    </Text>
                  </InlineStack>
                </BlockStack>

                <Button onClick={() => setOpen(false)}>Close</Button>
              </InlineStack>

              <div
                style={{
                  height: 340,
                  overflow: "auto",
                  border: "1px solid #e5e7eb",
                  borderRadius: 12,
                  padding: 12,
                }}
              >
                {loading || messages === null ? (
                  <InlineStack align="center">
                    <Spinner accessibilityLabel="Loading" size="small" />
                  </InlineStack>
                ) : messages.length === 0 ? (
                  <Text as="p" variant="bodyMd">
                    Write your first message.
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
                            {m.sender_role === "admin" ? "Support" : "You"}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {new Date(m.created_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
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
                    label="Message"
                    labelHidden
                    value={draft}
                    onChange={setDraft}
                    autoComplete="off"
                    multiline={3}
                  />
                </div>

                <Button variant="primary" onClick={send} loading={sending}>
                  Send
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </div>
      ) : null}
    </>
  );
}