import type { CallLanguage } from "./callLanguage.shared";

// Public premade voices and samples verified against ElevenLabs /v1/voices.
// No custom/private voices, signed preview URLs or API keys reach the client.
export const CALL_VOICES = [
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", description: "Female · clear and engaging · British English sample", sample: "d10f7534-11f6-41fe-a012-2de1e482d336" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", description: "Female · warm and bright · American English sample", sample: "56a97bf8-b69b-448f-846c-c3a11683d45a" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", description: "Male · relaxed and resonant · American English sample", sample: "58ee3ff5-f6f2-4628-93b8-e38eb31806b0" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris", description: "Male · friendly and down-to-earth · American English sample", sample: "3f4bde72-cc48-40dd-829f-57fbf906f4d7" },
].map(voice => ({ ...voice, previewUrl: `https://storage.googleapis.com/eleven-public-prod/premade/voices/${voice.id}/${voice.sample}.mp3` }));

export function validCallVoice(value: unknown): value is string {
  return value === "default" || CALL_VOICES.some(voice => voice.id === value);
}

export function callVoiceOverrides(value: unknown, language: CallLanguage) {
  if (value == null || value === "default") return {};
  if (!validCallVoice(value)) throw new Error("Saved call voice is unavailable. Select a voice in Automation settings.");
  return {
    voice: {
      provider: "11labs" as const,
      voiceId: value,
      model: "eleven_flash_v2_5" as const,
      language,
    },
  };
}
