// app/routes/app.billing.confirm.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { syncBillingFromShopify } from "../lib/billing.server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function asErrorMessage(e: unknown) {
  if (!e) return "Unknown error";
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;

  const anyE: any = e;
  if (anyE?.message && typeof anyE.message === "string") return anyE.message;

  try {
    const s = JSON.stringify(e);
    return s === "{}" ? "Unknown error" : s;
  } catch {
    return String(e);
  }
}

function billingAdminUrl(shop: string, extra?: Record<string, string>) {
  const apiKey = requiredEnv("SHOPIFY_API_KEY");
  const u = new URL(`https://${shop}/admin/apps/${apiKey}/app/billing`);

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && String(v).length) u.searchParams.set(k, String(v));
    }
  }

  return u.toString();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const auth: any = await authenticate.admin(request);
  const { admin, session } = auth;
  const shop = session.shop;

  try {
    await syncBillingFromShopify({ shop, admin });

    return new Response(null, {
      status: 303,
      headers: { Location: billingAdminUrl(shop, { ok: "1" }) },
    });
  } catch (e) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: billingAdminUrl(shop, {
          billing_error: asErrorMessage(e),
        }),
      },
    });
  }
}

export const headers: HeadersFunction = (args) => boundary.headers(args);