// app/routes/app.tsx
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Page } from "@shopify/polaris";
import { NavigationMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);

  return {
    shop: url.searchParams.get("shop"),
    host: url.searchParams.get("host"),
  };
};

export default function AppLayout() {
  const { shop, host } = useLoaderData<typeof loader>();

  const qs = new URLSearchParams();
  if (shop) qs.set("shop", shop);
  if (host) qs.set("host", host);
  qs.set("embedded", "1");

  const withQS = (path: string) => `${path}?${qs.toString()}`;

  return (
    <AppProvider embedded>
      <NavigationMenu
        navigationLinks={[
          { label: "Dashboard", destination: withQS("/app") },
          { label: "Checkouts", destination: withQS("/app/checkouts") },
          { label: "Calls", destination: withQS("/app/calls") },
          { label: "Settings", destination: withQS("/app/settings") },
        ]}
      />
      <Page fullWidth>
        <Outlet />
      </Page>
    </AppProvider>
  );
}

export const headers = (args: any) => boundary.headers(args);
export function ErrorBoundary() {
  return boundary.error();
}
