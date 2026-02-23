// app/routes/app.tsx
import type { LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  useLoaderData,
  useRouteError,
  isRouteErrorResponse,
  redirect,
} from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Page, Banner } from "@shopify/polaris";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");

  if (!shop || !host) return redirect("/auth/login");

  try {
    await authenticate.admin(request);
  } catch {
    return redirect("/auth/login");
  }

  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  if (!apiKey) return redirect("/auth/login");

  return { shop, host, apiKey };
};

export default function AppLayout() {
  const { shop, host, apiKey } = useLoaderData<typeof loader>();

  const qs = new URLSearchParams({
    shop,
    host,
    embedded: "1",
  });

  const link = (path: string) => `${path}?${qs.toString()}`;

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <a href={link("/app")}>Dashboard</a>
        <a href={link("/app/checkouts")}>Checkouts</a>
        <a href={link("/app/calls")}>Calls</a>
        <a href={link("/app/settings")}>Settings</a>
        <a href={link("/app/billing")}>Billing</a>
      </NavMenu>

      <Page fullWidth>
        <Outlet />
      </Page>
    </AppProvider>
  );
}

export const headers = boundary.headers;

export function ErrorBoundary() {
  const error = useRouteError();

  let message = "Unexpected error";
  if (isRouteErrorResponse(error)) message = `${error.status} ${error.statusText}`;
  else if (error instanceof Error) message = error.message;

  return (
    <AppProvider embedded apiKey={process.env.SHOPIFY_API_KEY ?? ""}>
      <Page>
        <Banner tone="critical" title="Application error">
          <p>{message}</p>
        </Banner>
      </Page>
    </AppProvider>
  );
}