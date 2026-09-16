import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Page, TextField, Button, BlockStack, Banner } from "@shopify/polaris";

import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useRouteError,
  isRouteErrorResponse,
  useNavigation,
} from "react-router";

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import styles from "./styles.module.css";

function Brand() {
  return (
    <div className={styles.brand}>
      <img src="/cartecho-icon.png" alt="" width="48" height="48" />
      <span>
        Cart<span className={styles.echo}>Echo</span>
      </span>
    </div>
  );
}

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
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <div className={styles.page}>
        <header className={styles.header}>
          <Brand />
          <a href="/support">
            Need help? <span aria-hidden="true">↗</span>
          </a>
        </header>
        <main className={styles.main}>
          <section className={styles.story} aria-labelledby="story-title">
            <span className={styles.eyebrow}>AI CART RECOVERY FOR SHOPIFY</span>
            <h2 id="story-title">
              A conversation.
              <br />A second chance
              <br />
              <span>to check out.</span>
            </h2>
            <p className={styles.intro}>
              Bring customers back with personal AI calls, thoughtful
              follow-ups, and a voice that represents your store.
            </p>
            <div className={styles.journey} aria-label="How CartEcho works">
              <div className={styles.journeyTitle}>
                <span className={styles.signal} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span>From cart to conversation</span>
              </div>
              <ol>
                <li>
                  <span className={styles.step}>01</span>
                  <div>
                    <strong>Spot the opportunity</strong>
                    <p>Keep abandoned checkouts in view.</p>
                  </div>
                </li>
                <li>
                  <span className={styles.step}>02</span>
                  <div>
                    <strong>Make it personal</strong>
                    <p>Reach out in your customer’s language.</p>
                  </div>
                </li>
                <li>
                  <span className={styles.step}>03</span>
                  <div>
                    <strong>Follow the result</strong>
                    <p>See conversations and recovered orders.</p>
                  </div>
                </li>
              </ol>
            </div>
            <p className={styles.storyNote}>
              Your store. Your voice. A more personal recovery.
            </p>
          </section>
          <section className={styles.login} aria-labelledby="login-title">
            <div className={styles.formCard}>
              <span className={styles.kicker}>YOUR CARTECHO WORKSPACE</span>
              <h1 id="login-title">Welcome back.</h1>
              <p className={styles.formIntro}>
                Log in with your Shopify store to pick up where you left off.
              </p>
              <Form method="post" aria-busy={busy}>
                <BlockStack gap="500">
                  <TextField
                    name="shop"
                    label="Shopify store domain"
                    placeholder="your-store.myshopify.com"
                    helpText="Use your store’s .myshopify.com domain."
                    value={shop}
                    onChange={setShop}
                    autoComplete="url"
                    spellCheck={false}
                    error={errors.shop}
                  />

                  <Button
                    submit
                    variant="primary"
                    size="large"
                    fullWidth
                    loading={busy}
                    disabled={busy}
                  >
                    Continue with Shopify
                  </Button>
                </BlockStack>
              </Form>
              <p className={styles.secure}>
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                >
                  <rect x="5" y="10" width="14" height="11" rx="2" />
                  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                </svg>
                Sign in securely through Shopify
              </p>
              <div className={styles.hint}>
                <strong>Already in Shopify?</strong>
                <p>
                  Open CartEcho from your store’s Apps menu to go straight to
                  your workspace.
                </p>
              </div>
            </div>
            <p className={styles.support}>
              A little help getting started?{" "}
              <a href="/documentation">
                Read the guide <span aria-hidden="true">↗</span>
              </a>
            </p>
          </section>
        </main>
        <footer className={styles.footer}>
          <span>CartEcho · AI Cart Recovery</span>
          <nav aria-label="Help and legal">
            <a href="/privacy">Privacy policy</a>
            <a href="/support">Support</a>
          </nav>
        </footer>
      </div>
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
