import * as React from "react";
import { BlockStack, Box, Text } from "@shopify/polaris";

type Props = {
  callJobId?: string | null;
  recordingUrl?: string | null;
};

export function CallRecordingPlayer({ callJobId, recordingUrl }: Props) {
  const [failed, setFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [audioSrc, setAudioSrc] = React.useState<string | null>(null);

  React.useEffect(() => {
    setFailed(false);
    setAudioSrc(null);
    if (!callJobId || !recordingUrl) return;

    const controller = new AbortController();
    let objectUrl: string | null = null;
    setLoading(true);

    void (async () => {
      try {
        const token = await (window as any).shopify?.idToken?.();
        const query = window.location.search || "";
        const response = await fetch(`/api/recording/${encodeURIComponent(callJobId)}${query}`, {
          signal: controller.signal,
          credentials: "same-origin",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!response.ok) throw new Error("Recording unavailable");
        const blob = await response.blob();
        if (!blob.size) throw new Error("Empty recording");
        objectUrl = URL.createObjectURL(blob);
        setAudioSrc(objectUrl);
      } catch (error: any) {
        if (error?.name !== "AbortError") setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [callJobId, recordingUrl]);

  if (!recordingUrl) return null;

  return (
    <Box background="bg-surface-secondary" borderRadius="300" padding="300">
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">Call recording</Text>
        {audioSrc ? (
          <audio
            controls
            preload="metadata"
            src={audioSrc}
            onError={() => setFailed(true)}
            aria-label="Call recording playback"
            style={{ display: "block", width: "100%", maxWidth: 560 }}
          >
            Your browser does not support audio playback.
          </audio>
        ) : null}
        {failed ? (
          <Text as="p" variant="bodySm" tone="critical">
            The recording is temporarily unavailable. The written transcript remains available below.
          </Text>
        ) : loading ? (
          <Text as="p" variant="bodySm" tone="subdued">Loading recording…</Text>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            Play the call without leaving CartEcho.
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}
