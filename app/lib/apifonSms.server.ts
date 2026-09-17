const APIFON_TOKEN_URL = "https://ids.apifon.com/oauth2/token";
const APIFON_SMS_URL = "https://ars.apifon.com/services/api/v1/sms/send";

export const DEFAULT_SMS_SENDER = "CartEcho";

type ApifonCredentials =
  | { kind: "oauth"; clientId: string; clientSecret: string }
  | { kind: "bearer"; token: string };

function readCredentials(): ApifonCredentials | null {
  // Apifon labels OAuth client credentials as "API Token / Client ID" and "API Key".
  const clientId = String(process.env.APIFON_CLIENT_ID ?? process.env.APIFON_API_TOKEN ?? "").trim();
  const clientSecret = String(
    process.env.APIFON_CLIENT_SECRET ?? process.env.APIFON_API_KEY ?? process.env.APIFON_API_SECRET ?? "",
  ).trim();
  if (clientId && clientSecret) return { kind: "oauth", clientId, clientSecret };

  const bearer = String(process.env.APIFON_BEARER_TOKEN ?? "").trim();
  return bearer ? { kind: "bearer", token: bearer } : null;
}

export function hasApifonSmsCredentials() {
  return readCredentials() !== null;
}

export function normalizeApifonRecipient(value: string) {
  return String(value ?? "").trim().replace(/[^\d+]/g, "").replace(/^\+/, "");
}

export function normalizeApifonSender(value: string) {
  const raw = String(value ?? "").trim().replace(/\s+/g, "");
  if (!raw) return "";

  if (/^\+?\d+$/.test(raw)) {
    return raw.replace(/^\+/, "").replace(/[^\d]/g, "").slice(0, 16);
  }

  return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 11);
}

export function configuredApifonSender() {
  const value = String(process.env.APIFON_SMS_SENDER ?? "").trim();
  return normalizeApifonSender(value) || DEFAULT_SMS_SENDER;
}

async function getAccessToken(credentials: ApifonCredentials) {
  if (credentials.kind === "bearer") {
    return credentials.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: String(process.env.APIFON_SCOPE ?? "smsGateway").trim() || "smsGateway",
  });
  const response = await fetch(String(process.env.APIFON_TOKEN_URL ?? APIFON_TOKEN_URL).trim(), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const responseText = await response.text();
  let data: any = null;
  try { data = responseText ? JSON.parse(responseText) : null; } catch { data = null; }

  const accessToken = String(data?.access_token ?? "").trim();
  if (!response.ok || !accessToken) {
    const reason = String(data?.error_description ?? data?.error ?? responseText).trim();
    const error: any = new Error(`Apifon authentication failed HTTP ${response.status}: ${reason.slice(0, 900)}`);
    error.status = response.status;
    throw error;
  }
  return accessToken;
}

function isUnicode(value: string) {
  return /[^\x00-\x7F]/.test(value);
}

export async function sendApifonSms(args: {
  toE164: string;
  content: string;
  sender?: string | null;
  referenceId?: string | null;
  callbackUrl?: string | null;
}) {
  const credentials = readCredentials();
  if (!credentials) throw new Error("Missing env: APIFON_API_TOKEN and APIFON_API_KEY");
  const accessToken = await getAccessToken(credentials);

  const recipient = normalizeApifonRecipient(args.toE164);
  if (!recipient || recipient.length < 7 || recipient.length > 15) {
    throw new Error("Invalid recipient phone");
  }

  const content = String(args.content ?? "").trim();
  if (!content) throw new Error("SMS content is empty");

  const requestedSender = normalizeApifonSender(args.sender ?? "") || configuredApifonSender();
  const callbackUrl = String(args.callbackUrl ?? process.env.APIFON_SMS_CALLBACK_URL ?? "").trim();

  const sendWithSender = async (sender: string) => {
    const payload: Record<string, unknown> = {
      subscribers: [{ number: recipient }],
      message: {
        text: content,
        dc: isUnicode(content) ? 2 : 0,
        sender_id: sender,
      },
    };
    const referenceId = String(args.referenceId ?? "").trim();
    if (referenceId) payload.reference_id = referenceId.slice(0, 255);
    if (callbackUrl) payload.callback_url = callbackUrl;

    const body = JSON.stringify(payload);
    const response = await fetch(APIFON_SMS_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
        Authorization: `Bearer ${accessToken}`,
      },
      body,
    });

    const responseText = await response.text();
    let data: any = null;
    try { data = responseText ? JSON.parse(responseText) : null; } catch { data = null; }

    const apiStatus = Number(data?.result_info?.status_code ?? response.status);
    if (!response.ok || apiStatus >= 400) {
      const error: any = new Error(
        `Apifon SMS failed HTTP ${response.status}: ${responseText.slice(0, 900)}`
      );
      error.status = response.ok ? apiStatus : response.status;
      throw error;
    }

    const details = data?.results?.[recipient];
    const first = Array.isArray(details) ? details[0] : null;
    return {
      messageId: String(first?.message_id ?? data?.request_id ?? "").trim() || null,
      requestId: String(data?.request_id ?? "").trim() || null,
      sender,
      raw: data,
    };
  };

  try {
    return await sendWithSender(requestedSender);
  } catch (error: any) {
    const status = Number(error?.status);
    const rejected = status === 400 || status === 403 || status === 422;
    if (requestedSender === DEFAULT_SMS_SENDER || !rejected) throw error;
    return sendWithSender(DEFAULT_SMS_SENDER);
  }
}

export async function sendDiscountSms(args: { to: string; code: string; checkoutUrl: string }) {
  const content = `Your discount code: ${String(args.code).trim()}. Complete checkout: ${String(args.checkoutUrl).trim()}`;
  const { messageId } = await sendApifonSms({
    toE164: args.to,
    content,
    referenceId: "discount",
  });
  return { messageId };
}
