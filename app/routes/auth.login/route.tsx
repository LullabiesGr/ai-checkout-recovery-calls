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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
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
