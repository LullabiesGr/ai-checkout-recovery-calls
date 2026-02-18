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
  json,
} from "react-router";

import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: polarisStyles }];

export async function loader({ request }: LoaderFunctionArgs) {
  return json({
    shopifyApiKey: process.env.SHOPIFY_API_KEY ?? "",
  });
}

export default function Root() {
  const { shopifyApiKey } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  React.useEffect(() => {
    const handleNavigate = (event: Event) => {
      const el = event.target as HTMLElement | null;
      const href = el?.getAttribute?.("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate as EventListener);
    return () =>
      document.removeEventListener("shopify:navigate", handleNavigate as EventListener);
  }, [navigate]);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />

        <meta name="shopify-api-key" content={shopifyApiKey} />
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>

        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />

        <Meta />
        <Links />
      </head>
      <body>
        <PolarisAppProvider i18n={enTranslations as any}>
          <Outlet />
        </PolarisAppProvider>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
