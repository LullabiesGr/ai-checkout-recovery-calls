// app/routes/app.billing.confirm.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function isValidShop(shop: string) {
  // strict enough to prevent open-redirects
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
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
  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") || "").trim();

  if (!isValidShop(shop)) {
    return new Response("Invalid shop", { status: 400 });
  }

  // Shopify redirects here after billing confirmation.
  // Bounce back into Admin embedded app.
  const to = billingAdminUrl(shop, { ok: "1" });
  return new Response(null, { status: 302, headers: { Location: to } });
}

export default function BillingConfirmRoute() {
  return null;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => boundary.headers(args);