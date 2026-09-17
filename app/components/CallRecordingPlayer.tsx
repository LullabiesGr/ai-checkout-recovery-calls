import * as React from "react";
import { BlockStack, Box, Text } from "@shopify/polaris";

type Props = {
  recordingUrl?: string | null;
};

export function CallRecordingPlayer({ recordingUrl }: Props) {
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => setFailed(false), [recordingUrl]);

  if (!recordingUrl) return null;

  return (
    <Box background="bg-surface-secondary" borderRadius="300" padding="300">
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">Call recording</Text>
        <audio
          controls
          preload="none"
          src={recordingUrl}
          onError={() => setFailed(true)}
          aria-label="Call recording playback"
          style={{ display: "block", width: "100%", maxWidth: 560 }}
        >
          Your browser does not support audio playback.
        </audio>
        {failed ? (
          <Text as="p" variant="bodySm" tone="critical">
            The recording is temporarily unavailable. The written transcript remains available below.
          </Text>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            Play the call without leaving CartEcho.
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}
