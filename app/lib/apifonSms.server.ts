import { createHmac } from "node:crypto";

const APIFON_SMS_PATH = "/services/api/v1/sms/send";
const APIFON_SMS_URL = `https://ars.apifon.com${APIFON_SMS_PATH}`;

export const DEFAULT_SMS_SENDER = "CartEcho";

type ApifonCredentials =
  | { kind: "hmac"; token: string; secret: string }
  | { kind: "bearer"; token: string };

function readCredentials(): ApifonCredentials | null {
  const token = String(process.env.APIFON_API_TOKEN ?? "").trim();
  const secret = String(process.env.APIFON_API_SECRET ?? "").trim();
  if (token && secret) return { kind: "hmac", token, secret };

  const combined = String(process.env.APIFON_API_KEY ?? "").trim();
  const separator = combined.indexOf(":");
  if (separator > 0 && separator < combined.length - 1) {
    return {
      kind: "hmac",
      token: combined.slice(0, separator).trim(),
      secret: combined.slice(separator + 1).trim(),
    };
  }

  const bearer = String(process.env.APIFON_BEARER_TOKEN ?? combined).trim();
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

function authorizationHeaders(credentials: ApifonCredentials, body: string): Record<string, string> {
  if (credentials.kind === "bearer") {
    return { Authorization: `Bearer ${credentials.token}` };
  }

  const requestDate = new Date().toUTCString();
  const stringToSign = `POST\n${APIFON_SMS_PATH}\n${body}\n${requestDate}`;
  const signature = createHmac("sha256", credentials.secret).update(stringToSign).digest("base64");
  return {
    Authorization: `ApifonWS ${credentials.token}:${signature}`,
    "X-ApifonWS-Date": requestDate,
  };
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
  if (!credentials) throw new Error("Missing env: APIFON_API_KEY");

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
        ...authorizationHeaders(credentials, body),
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
