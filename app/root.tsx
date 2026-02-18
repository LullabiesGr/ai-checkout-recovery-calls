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
} from "react-router";

import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  { rel: "stylesheet", href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css" },
  { rel: "stylesheet", href: polarisStyles },
];

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    shopifyApiKey: process.env.SHOPIFY_API_KEY ?? "",
  };
}

export default function App() {
  const { shopifyApiKey } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  React.useEffect(() => {
    const handleNavigate = (event: Event) => {
      const el = event.target as HTMLElement | null;
      const href = el?.getAttribute?.("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate as EventListener);
    return () => {
      document.removeEventListener("shopify:navigate", handleNavigate as EventListener);
    };
  }, [navigate]);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="shopify-api-key" content={shopifyApiKey} />
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
