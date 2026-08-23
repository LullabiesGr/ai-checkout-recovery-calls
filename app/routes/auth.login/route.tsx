import { AppProvider } from "@shopify/shopify-app-react-router/react";
import {
  Page,
  Card,
  TextField,
  Button,
  BlockStack,
  Banner,
} from "@shopify/polaris";

import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useRouteError,
  isRouteErrorResponse,
} from "react-router";

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

function normalizeShopDomain(value: string) {
  const shop = String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");

  // Common typo / admin shorthand: mystore.shopify.com -> mystore.myshopify.com
  // Do not rewrite admin.shopify.com because it is not a store domain.
  if (
    shop.endsWith(".shopify.com") &&
    !shop.endsWith(".myshopify.com") &&
    shop !== "admin.shopify.com"
  ) {
    return `${shop.slice(0, -".shopify.com".length)}.myshopify.com`;
  }

  return shop;
}

async function normalizeLoginRequest(request: Request) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const shop = url.searchParams.get("shop");
    if (!shop) return request;

    const normalized = normalizeShopDomain(shop);
    if (normalized === shop) return request;

    url.searchParams.set("shop", normalized);
    return new Request(url.toString(), {
      method: "GET",
      headers: request.headers,
    });
  }

  const form = await request.clone().formData();
  const shop = String(form.get("shop") ?? "");
  if (!shop) return request;

  const normalized = normalizeShopDomain(shop);
  if (normalized === shop) return request;

  form.set("shop", normalized);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: form,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const normalizedRequest = await normalizeLoginRequest(request);
  const errors = loginErrorMessage(await login(normalizedRequest));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const normalizedRequest = await normalizeLoginRequest(request);
  const errors = loginErrorMessage(await login(normalizedRequest));
  return { errors };
};

export default function AuthLoginRoute() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [shop, setShop] = useState("");

  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <Page title="Log in">
        <Card>
          <Form method="post">
            <BlockStack gap="300">
              <TextField
                name="shop"
                label="Shop domain"
                helpText="example.myshopify.com"
                value={shop}
                onChange={setShop}
                autoComplete="on"
                error={errors.shop}
              />

              <Button submit variant="primary">
                Log in
              </Button>
            </BlockStack>
          </Form>
        </Card>
      </Page>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let message = "Login failed";

  if (isRouteErrorResponse(error)) {
    message = `${error.status} ${error.statusText}`;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <AppProvider embedded={false}>
      <Page>
        <Banner tone="critical" title="Authentication error">
          <p>{message}</p>
        </Banner>
      </Page>
    </AppProvider>
  );
}
