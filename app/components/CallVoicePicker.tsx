import * as React from "react";
import { BlockStack, Select, Text, Banner } from "@shopify/polaris";
import { CALL_VOICES } from "../lib/callVoice.shared";

export function CallVoicePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const selected = CALL_VOICES.find(voice => voice.id === value);
  const [failed, setFailed] = React.useState(false);
  return (
    <BlockStack gap="300">
      <Select
        label="Agent voice"
        name="callVoice"
        value={value}
        onChange={next => { setFailed(false); onChange(next); }}
        options={[
          { label: "Keep current Vapi assistant voice", value: "default" },
          ...CALL_VOICES.map(voice => ({ label: `${voice.name} — ElevenLabs`, value: voice.id })),
        ]}
        helpText="Save to apply this voice to all future automatic, manual and test calls for this store. Calls already in progress are unchanged."
      />
      {selected ? (
        <BlockStack gap="200">
          <Text as="p">{selected.description}</Text>
          <audio
            key={selected.id}
            controls
            preload="none"
            src={selected.previewUrl}
            aria-label={`Preview ${selected.name}'s voice`}
            onError={() => setFailed(true)}
            style={{ width: "100%", maxWidth: 420 }}
          >Your browser does not support audio previews.</audio>
          {failed ? <Banner tone="warning" title="Audio preview could not load. Select the voice again to retry." /> : null}
          <Text as="p" variant="bodySm" tone="subdued">
            Official ElevenLabs sample, not a live call. Listening uses no attempts. The sample is in English; calls use your Call language setting with Eleven Flash v2.5. Accent and delivery can vary by language.
          </Text>
        </BlockStack>
      ) : (
        <Text as="p" variant="bodySm" tone="subdued">
          Keeps the provider, voice and model already configured in Vapi. Select an ElevenLabs voice above to hear a sample and override it for this store only.
        </Text>
      )}
    </BlockStack>
  );
}
