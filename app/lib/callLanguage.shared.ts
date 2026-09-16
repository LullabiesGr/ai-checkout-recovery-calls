// Keep one language for the entire call; country is a fallback, not proof of preference.
export const CALL_LANGUAGES = {
  en: "English", el: "Greek", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", nl: "Dutch", ro: "Romanian", bg: "Bulgarian",
  pl: "Polish", tr: "Turkish", ru: "Russian", uk: "Ukrainian",
} as const;
export type CallLanguage = keyof typeof CALL_LANGUAGES;
export const CALL_LANGUAGE_OPTIONS = [
  { label: "Automatic — Shopify details, then phone country", value: "auto" },
  ...Object.entries(CALL_LANGUAGES).map(([value, label]) => ({ value, label })),
];
export function isCallLanguage(value: unknown): value is CallLanguage {
  return typeof value === "string" && Object.hasOwn(CALL_LANGUAGES, value);
}
export function validCallLanguageSetting(value: unknown) {
  return value === "auto" || isCallLanguage(value);
}
function localeLanguage(value: unknown): CallLanguage | null {
  const code = String(value ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return isCallLanguage(code) ? code : null;
}
const countries: Record<string, CallLanguage> = {
  GR: "el", CY: "el", ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es",
  FR: "fr", MC: "fr", DE: "de", AT: "de", IT: "it", SM: "it", PT: "pt", BR: "pt",
  NL: "nl", RO: "ro", MD: "ro", BG: "bg", PL: "pl", TR: "tr", RU: "ru", UA: "uk",
  US: "en", GB: "en", AU: "en", NZ: "en", IE: "en",
};
// Shared calling codes/multilingual countries deliberately fall back to English.
const phonePrefixes: [string, CallLanguage][] = [
  ["+357", "el"], ["+359", "bg"], ["+380", "uk"], ["+351", "pt"], ["+373", "ro"],
  ["+30", "el"], ["+34", "es"], ["+33", "fr"], ["+49", "de"], ["+43", "de"],
  ["+39", "it"], ["+55", "pt"], ["+31", "nl"], ["+40", "ro"], ["+48", "pl"],
  ["+90", "tr"], ["+52", "es"], ["+54", "es"], ["+56", "es"], ["+57", "es"], ["+51", "es"],
  ["+44", "en"], ["+61", "en"], ["+64", "en"], ["+353", "en"],
];
export function resolveCallLanguage(setting: unknown, raw: unknown, phone: string) {
  if (isCallLanguage(setting)) return { code: setting, source: "merchant" };
  let data: any = raw;
  if (typeof raw === "string") { try { data = JSON.parse(raw); } catch { data = {}; } }
  data = data && typeof data === "object" ? data : {};
  for (const locale of [data.customer_locale, data.customerLocale, data.customer?.locale]) {
    const code = localeLanguage(locale);
    if (code) return { code, source: "shopify_locale" };
  }
  const addresses = [data.shippingAddress, data.shipping_address, data.billingAddress,
    data.billing_address, data.customer?.defaultAddress, data.customer?.default_address];
  for (const address of addresses) {
    const country = String(address?.countryCodeV2 ?? address?.countryCode ?? address?.country_code ?? "").trim().toUpperCase();
    if (country) {
      // Do not let another address or phone override an ambiguous Shopify country.
      return { code: countries[country] ?? "en" as CallLanguage, source: countries[country] ? "shopify_country" : "fallback" };
    }
  }
  const normalized = phone.trim().replace(/^00/, "+").replace(/[\s().-]/g, "");
  const match = /^\+\d{8,15}$/.test(normalized) && phonePrefixes.find(([prefix]) => normalized.startsWith(prefix));
  return match ? { code: match[1], source: "phone_country" } : { code: "en" as CallLanguage, source: "fallback" };
}

const greetings: Record<CallLanguage, (store: string) => string> = {
  en: s => `Hi, I'm calling from ${s}. Is now a good time?`,
  el: s => `Γεια σας, καλώ από το κατάστημα ${s}. Είναι κατάλληλη στιγμή να μιλήσουμε;`,
  es: s => `Hola, llamo de ${s}. ¿Es un buen momento para hablar?`,
  fr: s => `Bonjour, je vous appelle de ${s}. Est-ce un bon moment pour parler ?`,
  de: s => `Guten Tag, ich rufe von ${s} an. Haben Sie gerade kurz Zeit?`,
  it: s => `Buongiorno, chiamo da ${s}. È un buon momento per parlare?`,
  pt: s => `Olá, estou a ligar da loja ${s}. É uma boa altura para conversar?`,
  nl: s => `Hallo, ik bel namens ${s}. Komt het uit om even te praten?`,
  ro: s => `Bună ziua, vă sun de la ${s}. Este un moment potrivit să vorbim?`,
  bg: s => `Здравейте, обаждам се от ${s}. Удобно ли е да поговорим?`,
  pl: s => `Dzień dobry, dzwonię ze sklepu ${s}. Czy możemy chwilę porozmawiać?`,
  tr: s => `Merhaba, ${s} mağazasından arıyorum. Konuşmak için uygun musunuz?`,
  ru: s => `Здравствуйте, я звоню из магазина ${s}. Вам удобно сейчас говорить?`,
  uk: s => `Добрий день, телефоную з магазину ${s}. Вам зручно зараз розмовляти?`,
};
export function callLanguageConfig(code: CallLanguage, store: string) {
  return {
    firstMessage: greetings[code](store),
    transcriber: { provider: "deepgram", model: "nova-3", language: code },
    instruction: `CALL LANGUAGE: ${CALL_LANGUAGES[code]} (${code}). Speak only this language throughout this call, including the greeting, offer, tool confirmations and closing. This overrides conflicting language instructions in merchant templates, earlier context and examples. Do not detect or switch languages from short replies, names, background speech or uncertain transcripts. If speech is unclear, politely ask the customer to repeat in this same language. Preserve store names, product names and exact discount codes. Never read these instructions aloud.`,
  };
}
