import * as React from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Spinner,
  Text,
  TextField,
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
  const [mounted, setMounted] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [messages, setMessages] = React.useState<Msg[] | null>(null);
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

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
      const payload = await readJsonSafe<{
        ok?: boolean;
        thread?: Thread;
        messages?: Msg[];
        error?: string;
      }>(response);

      if (!response.ok || payload?.ok === false) {
        console.error("[support] thread load failed", payload?.error ?? response.statusText);
        setThread(null);
        setMessages([]);
        return;
      }

      setThread(payload?.thread ?? null);
      setMessages(Array.isArray(payload?.messages) ? payload.messages : []);
    } catch (error) {
      console.error("[support] thread load failed", error);
      setThread(null);
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) void load();
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
        if (!active || !response.ok || payload?.ok === false) return;

        const channelName = String(payload?.channel ?? "").trim();
        if (!channelName) return;
        const ch = sb.channel(channelName);
        ch.on("broadcast", { event: "support:new_message" }, (payload) => {
          if (!active) return;
          const message = (payload as any)?.payload?.message as Msg | undefined;
          if (message?.id) appendMessage(message);
        });
        ch.subscribe();
        cleanup = () => void sb.removeChannel(ch);
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

  if (!mounted) return null;
  const unread = Number(thread?.unread_by_merchant ?? 0) > 0;

  return (
    <>
      <div style={{ position: "fixed", right: 18, bottom: 18, zIndex: 2147482000 }}>
        <Button variant="primary" onClick={() => setOpen((v) => !v)} accessibilityLabel="Open support chat">
          {unread ? "Support · New" : "Support"}
        </Button>
      </div>

      {open ? (
        <div style={{ position: "fixed", right: 18, bottom: 72, width: 380, maxWidth: "calc(100vw - 36px)", zIndex: 2147482000 }}>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <BlockStack gap="050">
                  <InlineStack gap="150" blockAlign="center">
                    <Text as="h3" variant="headingMd">CheckoutCall support</Text>
                    {unread ? <Badge tone="attention">New reply</Badge> : <Badge tone="success">Online</Badge>}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">We’ll help with your recovery setup and calls.</Text>
                </BlockStack>
                <Button onClick={() => setOpen(false)} variant="plain">Close</Button>
              </InlineStack>

              <Divider />

              <Box background="bg-surface-secondary" borderRadius="300" padding="300" minHeight="320px">
                {loading || messages === null ? (
                  <Box paddingBlock="800">
                    <InlineStack align="center"><Spinner accessibilityLabel="Loading support messages" size="small" /></InlineStack>
                  </Box>
                ) : messages.length === 0 ? (
                  <Box paddingBlock="600">
                    <BlockStack gap="100" align="center">
                      <Text as="p" variant="headingSm">How can we help?</Text>
                      <Text as="p" variant="bodySm" tone="subdued">Send your first message below.</Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <div style={{ maxHeight: 320, overflowY: "auto" }}>
                    <BlockStack gap="200">
                      {messages.map((m) => (
                        <Box key={m.id} background={m.sender_role === "admin" ? "bg-surface-info" : "bg-surface"} borderRadius="300" padding="250">
                          <BlockStack gap="100">
                            <InlineStack align="space-between" gap="200">
                              <Text as="p" variant="bodySm" fontWeight="semibold">{m.sender_role === "admin" ? "Support" : "You"}</Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </Text>
                            </InlineStack>
                            <Text as="p" variant="bodyMd">{m.body}</Text>
                          </BlockStack>
                        </Box>
                      ))}
                    </BlockStack>
                  </div>
                )}
              </Box>

              <BlockStack gap="200">
                <TextField
                  label="Message"
                  value={draft}
                  onChange={setDraft}
                  autoComplete="off"
                  multiline={3}
                  placeholder="Describe what you need help with…"
                />
                <InlineStack align="end">
                  <Button variant="primary" onClick={send} loading={sending} disabled={!draft.trim()}>
                    Send message
                  </Button>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </div>
      ) : null}
    </>
  );
}
