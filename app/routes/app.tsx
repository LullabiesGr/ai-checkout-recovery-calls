import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { isPlatformAdminEmail } from "../lib/support.server";
import { SupportBubble } from "../components/SupportBubble";

const EMBED_KEYS = ["shop", "host", "embedded", "locale"] as const;
const EMBED_STORAGE_KEY = "__shopify_embed_params_v1";

function pickEmbeddedParams(search: string) {
  const src = new URLSearchParams(search);
  const keep = new URLSearchParams();
  for (const k of EMBED_KEYS) {
    const v = src.get(k);
    if (v) keep.set(k, v);
  }
  return keep;
}

function mergeSearch(path: string, keep: URLSearchParams) {
  const keepStr = keep.toString();
  if (!keepStr) return path;

  if (!path.includes("?")) return `${path}?${keepStr}`;

  const [base, q = ""] = path.split("?");
  const out = new URLSearchParams(q);
  for (const [k, v] of keep.entries()) if (!out.has(k)) out.set(k, v);
  const outStr = out.toString();
  return outStr ? `${base}?${outStr}` : base;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = session.shop;
  const email = session.email ?? null;

  return {
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    shop,
    isPlatformAdmin: isPlatformAdminEmail(email),
  };
}

export default function App() {
  const { apiKey, shop, isPlatformAdmin } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();

  const embeddedParams = React.useMemo(() => pickEmbeddedParams(location.search), [location.search]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const current = pickEmbeddedParams(window.location.search);
    const hasHost = Boolean(current.get("host"));

    if (hasHost) {
      const payload: Record<string, string> = {};
      for (const k of EMBED_KEYS) {
        const v = current.get(k);
        if (v) payload[k] = v;
      }
      window.sessionStorage.setItem(EMBED_STORAGE_KEY, JSON.stringify(payload));
      return;
    }

    const raw = window.sessionStorage.getItem(EMBED_STORAGE_KEY);
    if (!raw) return;

    let saved: Record<string, string> | null = null;
    try {
      saved = JSON.parse(raw);
    } catch {
      return;
    }
    if (!saved?.host) return;

    const next = new URL(window.location.href);
    for (const k of EMBED_KEYS) {
      const v = saved[k];
      if (v && !next.searchParams.get(k)) next.searchParams.set(k, v);
    }

    const nextUrl = `${next.pathname}?${next.searchParams.toString()}${next.hash ?? ""}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash ?? ""}`;
    if (nextUrl !== currentUrl) navigate(nextUrl, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const href = React.useCallback(
    (path: string) => mergeSearch(path, embeddedParams),
    [embeddedParams],
  );

  return (
    <AppProvider embedded apiKey={apiKey}>
      <ui-nav-menu>
        <a href={href("/app")} rel="home">Dashboard</a>
        <a href={href("/app/checkouts")}>Checkouts</a>
        <a href={href("/app/settings")}>Settings</a>
        <a href={href("/app/billing")}>Billing</a>
        {isPlatformAdmin ? <a href={href("/app/admin/support")}>Support Inbox</a> : null}
      </ui-nav-menu>

      <Outlet />

      <SupportBubble shop={shop} />
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}