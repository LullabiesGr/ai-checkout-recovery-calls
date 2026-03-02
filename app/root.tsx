// app/root.tsx
import * as React from "react";
import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useNavigate,
  useNavigation,
} from "react-router";

import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: polarisStyles }];

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    shopifyApiKey: process.env.SHOPIFY_API_KEY ?? "",
    supabaseUrl: process.env.SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  };
}

function BootLoader({ hidden, note }: { hidden: boolean; note: string }) {
  if (hidden) return null;

  return (
    <div
      id="boot-loader"
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
        zIndex: 2147483647,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 16 }}>
        <div
          aria-hidden="true"
          style={{
            width: 16,
            height: 16,
            border: "2px solid #d1d5db",
            borderTopColor: "#111827",
            borderRadius: 999,
            animation: "bootspin 0.8s linear infinite",
          }}
        />
        <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial", color: "#111827" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Loading app</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{note}</div>
        </div>
      </div>
    </div>
  );
}

function RouteProgressBar({ active }: { active: boolean }) {
  if (!active) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 2147483000,
        background: "linear-gradient(90deg, transparent, #111827, transparent)",
        animation: "routebar 1s linear infinite",
      }}
    />
  );
}

export default function Root() {
  const { shopifyApiKey, supabaseUrl, supabaseAnonKey } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();

  const [bootHidden, setBootHidden] = React.useState(false);
  const [bootNote, setBootNote] = React.useState("Preparing dashboard and syncing shop session");

  React.useEffect(() => {
    const handleNavigate = (event: Event) => {
      const el = event.target as HTMLElement | null;
      const href = el?.getAttribute?.("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate as EventListener);
    return () => document.removeEventListener("shopify:navigate", handleNavigate as EventListener);
  }, [navigate]);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setBootNote("Still loading… verifying Shopify session and network");
    }, 8000);

    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => setBootHidden(true));
      return () => cancelAnimationFrame(raf2);
    });

    return () => {
      window.clearTimeout(t);
      cancelAnimationFrame(raf1);
    };
  }, []);

  const routeBusy = navigation.state !== "idle";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />

        <meta name="shopify-api-key" content={shopifyApiKey} />
        <meta name="supabase-url" content={supabaseUrl} />
        <meta name="supabase-anon-key" content={supabaseAnonKey} />

        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>

        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />

        <style>{`
          @keyframes bootspin { to { transform: rotate(360deg); } }
          @keyframes routebar {
            0% { background-position: -200px 0; }
            100% { background-position: 200px 0; }
          }
        `}</style>

        <Meta />
        <Links />
      </head>
      <body>
        <BootLoader hidden={bootHidden} note={bootNote} />
        <RouteProgressBar active={routeBusy} />

        <PolarisAppProvider i18n={enTranslations as any}>
          <Outlet />
        </PolarisAppProvider>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}