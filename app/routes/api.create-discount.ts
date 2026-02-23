import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { sessionStorage } from "../shopify.server";
import { randomBytes } from "node:crypto";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const SHOPIFY_ADMIN_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION ?? "2025-07";

async function getOfflineAccessToken(shop: string): Promise<string> {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  const offline = sessions.find((s: any) => s && s.isOnline === false);
  const token = String((offline as any)?.accessToken ?? "").trim();
  if (!token) throw new Error(`Missing offline access token for shop=${shop}. Reinstall app to reauthorize scopes.`);
  return token;
}

async function shopifyGraphql(shop: string, accessToken: string, query: string, variables: any) {
  const endpoint = `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Shopify GraphQL non-JSON response HTTP ${res.status}: ${text.slice(0, 800)}`);
  }

  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (Array.isArray(json?.errors) && json.errors.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json;
}

function hoursFromNowIso(hours: number) {
  const h = Math.max(1, Math.min(168, Math.floor(Number(hours) || 24)));
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

function normalizePrefix(prefix: string | null) {
  const p = String(prefix ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return p.slice(0, 10) || "OFFER";
}

function makeUniqueCode(prefix: string | null, percent: number) {
  const pct = Math.max(1, Math.min(99, Math.floor(Number(percent) || 0)));
  const pfx = normalizePrefix(prefix).slice(0, 8);
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `${pfx}-${pct}-${rand}`.slice(0, 45);
}

async function createDiscountCodeBasic(params: {
  shop: string;
  accessToken: string;
  code: string;
  percent: number;
  startsAt: string;
  endsAt: string;
}) {
  const mutation = `
    mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const pct = Math.max(1, Math.min(99, Math.floor(Number(params.percent) || 0)));
  const percentage = Math.max(0.01, Math.min(0.99, pct / 100));

  const basicCodeDiscount: any = {
    title: `${pct}% Recovery`,
    code: params.code,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    appliesOncePerCustomer: true,
    customerSelection: { all: true },
    customerGets: { value: { percentage }, items: { all: true } },
  };

  const out = await shopifyGraphql(params.shop, params.accessToken, mutation, { basicCodeDiscount });
  const payload = out?.data?.discountCodeBasicCreate;
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => String(e?.message ?? "")).filter(Boolean).join(" | "));

  const nodeId = payload?.codeDiscountNode?.id ?? null;
  const createdCode = payload?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ?? null;
  if (!nodeId) throw new Error(`discountCodeBasicCreate returned no codeDiscountNode: ${JSON.stringify(payload)}`);

  return { nodeId: String(nodeId), createdCode: createdCode ? String(createdCode) : null };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const secret = request.headers.get("x-internal-secret");
  if (secret !== requiredEnv("INTERNAL_API_SECRET")) {
    return new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const body = await request.json().catch(() => ({}));
  const shop = String(body?.shop ?? "").trim();
  const checkoutId = String(body?.checkoutId ?? "").trim();
  const percent = Number(body?.percent ?? 10);

  if (!shop || !checkoutId) {
    return new Response(JSON.stringify({ success: false, error: "shop and checkoutId required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const checkout = await db.checkout.findFirst({ where: { shop, checkoutId } });
  if (!checkout) {
    return new Response(JSON.stringify({ success: false, error: "checkout not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const settings = await db.settings.findUnique({ where: { shop } });
  const prefix = String((settings as any)?.coupon_prefix ?? "").trim() || null;
  const validityHours = Number((settings as any)?.coupon_validity_hours ?? 24);

  const accessToken = await getOfflineAccessToken(shop);
  const candidate = makeUniqueCode(prefix, percent);

  const created = await createDiscountCodeBasic({
    shop,
    accessToken,
    code: candidate,
    percent,
    startsAt: new Date().toISOString(),
    endsAt: hoursFromNowIso(validityHours),
  });

  return new Response(
    JSON.stringify({
      success: true,
      nodeId: created.nodeId,
      code: created.createdCode ?? candidate,
      apiVersion: SHOPIFY_ADMIN_API_VERSION,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}