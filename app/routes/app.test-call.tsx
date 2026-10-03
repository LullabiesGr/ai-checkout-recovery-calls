import { useAppBridge } from "@shopify/app-bridge-react";
import { TEST_SHOP_QUERY, resolveTestCatalog } from "../lib/testCatalog.server";
import { useState } from "react";
import { randomUUID } from "node:crypto";
import { useLoaderData, useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Page, Card, BlockStack, Text, Banner, FormLayout, TextField, Thumbnail, Box, InlineGrid, InlineStack, Button } from "@shopify/polaris";
import { Form } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { startVapiCallForJob } from "../callProvider.server";
export { ErrorBoundary, headers } from "./app.dashboard";

function buildCheckoutPermalink(shop: string, itemsJson: string, email?: string | null) {
  const items = JSON.parse(itemsJson) as Array<{ variantId?: string; quantity?: number }>;
  const lines = items.map((item) => {
    const gid = String(item?.variantId ?? "");
    const variantId = gid.split("/").pop() ?? "";
    const quantity = Number(item?.quantity ?? 1);
    if (!/^\d+$/.test(variantId) || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Could not build the Shopify checkout link for the selected products.");
    }
    return `${variantId}:${quantity}`;
  });
  if (!lines.length) throw new Error("Select at least one product.");
  const url = new URL(`https://${shop}/cart/${lines.join(",")}`);
  if (email) url.searchParams.set("checkout[email]", email);
  return url.toString();
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const fd = await request.formData();
  const phone = String(fd.get("phone") ?? "").replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    return { ok: false, message: "Enter your phone number with country code, for example +306900000000." };
  }

  let testCart: Awaited<ReturnType<typeof resolveTestCatalog>>;
  try {
    testCart = await resolveTestCatalog(admin, fd);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Check the test cart details." };
  }

  const nonce = String(fd.get("testCallId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) {
    return { ok: false, message: "Refresh the page before starting a test call." };
  }

  const shop = session.shop;
  const checkoutId = `test-${nonce}`;
  const id = `${shop}:${checkoutId}`;

  let checkoutUrl: string;
  try {
    checkoutUrl = buildCheckoutPermalink(shop, testCart.itemsJson, testCart.email);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not create the Shopify checkout link." };
  }

  const raw = JSON.stringify({
    testCall: true,
    abandonedCheckoutUrl: checkoutUrl,
    recoveryUrl: checkoutUrl,
  });

  const created = await db.$transaction(async (tx) => {
    const checkout = await tx.checkout.upsert({
      where: { shop_checkoutId: { shop, checkoutId } },
      update: { phone, ...testCart, raw },
      create: { shop, checkoutId, phone, ...testCart, status: "OPEN", raw },
    });
    await tx.$queryRaw`SELECT id FROM "Checkout" WHERE id = ${checkout.id} FOR UPDATE`;
    if (await tx.callJob.findFirst({ where: { shop, id } })) return false;
    await tx.callJob.create({ data: { id, shop, checkoutId, phone, status: "CALLING", scheduledFor: new Date(), attempts: 1 } });
    return true;
  });

  if (!created) return { ok: false, message: "This test call has already been submitted. Refresh to start another." };

  try {
    await startVapiCallForJob({ shop, callJobId: id });
    return { ok: true, message: "Test call started. If the customer asks for the link, CartEcho can now send a real Shopify checkout URL by SMS." };
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : "";
    await db.callJob.updateMany({ where: { shop, id, status: "CALLING" }, data: { status: "FAILED", outcome: "TEST_CALL_FAILED" } });
    const friendly = code === "ATTEMPT_LIMIT_REACHED"
      ? "No attempts are available. Add attempts or change plan, then try again."
      : code === "ACTIVE_SUBSCRIPTION_REQUIRED" || code === "MONTHLY_PLAN_REQUIRED"
        ? "An active plan is required to place this test call."
        : "The test call could not start. Check the call provider settings and try again.";
    return { ok: false, message: friendly };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(TEST_SHOP_QUERY);
  const body: any = await response.json();
  if (body.errors?.length || !body.data?.shop) throw new Response("Store details could not be loaded. Please reload.", { status: 502 });
  return { testCallId: randomUUID(), storeName: body.data.shop.name as string, currency: body.data.shop.currencyCode as string, dashboardHref: `/app/dashboard${new URL(request.url).search}` };
}
export default function TestCallRoute() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [testPhone, setTestPhone] = useState("");
  const [testName, setTestName] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const testCurrency = data.currency;
  const shopify = useAppBridge();
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [testItems, setTestItems] = useState<Array<{ productId: string; variantId: string; title: string; quantity: string; price: string; image: string }>>([]);
  async function selectProducts() {
    setPicking(true); setPickerError("");
    try {
      const byProduct = new Map<string, { id: string; variants: { id: string }[] }>();
      for (const item of testItems) {
        const product = byProduct.get(item.productId) || { id: item.productId, variants: [] };
        product.variants.push({ id: item.variantId }); byProduct.set(item.productId, product);
      }
      const selection = await shopify.resourcePicker({ type: "product", action: "select", multiple: 10, filter: { variants: true, draft: false, archived: false }, selectionIds: [...byProduct.values()] });
      if (!selection) return;
      const next = selection.flatMap(product => product.variants.filter(variant => variant.id).map(variant => ({
        productId: product.id, variantId: variant.id!,
        title: !variant.title || variant.title === "Default Title" ? product.title : `${product.title} — ${variant.title}`,
        quantity: testItems.find(item => item.variantId === variant.id)?.quantity || "1",
        price: String(variant.price ?? "0"), image: variant.image?.originalSrc || product.images?.[0]?.originalSrc || "",
      })));
      if (next.length > 10) { setPickerError("Select up to 10 variants in total."); return; }
      setTestItems(next);
    } catch { setPickerError("The product list could not open. Open this app inside Shopify Admin and check product access."); }
    finally { setPicking(false); }
  }
  const testTotal = testItems.reduce((total, item) => total + (Number(item.quantity) || 0) * (Number(item.price.replace(",", ".")) || 0), 0);
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  return <Page title="Test call" subtitle={`Simulate a recovery call from ${data.storeName}`} backAction={{ content: "Dashboard", url: data.dashboardHref }}>
    <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="create_test_call" />
            <input type="hidden" name="testCallId" value={data.testCallId} />
            <input type="hidden" name="catalog" value="true" />
            <input type="hidden" name="currency" value={testCurrency} />
            <input type="hidden" name="items" value={JSON.stringify(testItems)} />
            <BlockStack gap="400">
              <Text as="p">The agent uses your current automation settings and the customer and cart details below. This places a real call to your test number and uses one attempt. CartEcho also creates a real Shopify checkout permalink from the selected variants so the SMS flow can be tested end to end. It does not create an order unless the checkout is completed.</Text>
              {result ? <Banner tone={result.ok ? "success" : "critical"}><p>{result.message}</p></Banner> : null}
              <FormLayout>
                <TextField label="Customer name" name="customerName" value={testName} onChange={setTestName} autoComplete="name" requiredIndicator disabled={submitting} />
                <TextField label="Your test phone number" type="tel" name="phone" value={testPhone} onChange={setTestPhone} autoComplete="tel" placeholder="+306900000000" helpText="Include the country code." requiredIndicator disabled={submitting} />
                <TextField label="Email (optional)" type="email" name="email" value={testEmail} onChange={setTestEmail} autoComplete="email" disabled={submitting} />
                <Text as="p" tone="subdued">Store currency: {testCurrency}</Text>
              </FormLayout>
              <Text as="h3" variant="headingSm">Cart products</Text>
              {pickerError ? <Banner tone="critical"><p>{pickerError}</p></Banner> : null}
              <Button onClick={selectProducts} loading={picking} disabled={submitting || picking}>Select store products</Button>
              {!testItems.length ? <Text as="p" tone="subdued">Choose products and variants from your Shopify catalog.</Text> : null}
              {testItems.map((item, index) => <Box key={item.variantId} padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="center">
                    {item.image ? <Thumbnail source={item.image} alt={item.title} size="small" /> : null}
                    <Text as="p" fontWeight="semibold">{item.title}</Text>
                  </InlineStack>
                  <InlineGrid columns={2} gap="300">
                    <TextField label="Quantity" type="number" min={1} max={1000} value={item.quantity} onChange={value => setTestItems(items => items.map((row, i) => i === index ? { ...row, quantity: value } : row))} autoComplete="off" disabled={submitting} />
                    <Text as="p">Unit price: {item.price} {testCurrency}</Text>
                  </InlineGrid>
                  {testItems.length > 0 ? <Button tone="critical" variant="plain" disabled={submitting} onClick={() => setTestItems(items => items.filter((_, i) => i !== index))}>Remove product</Button> : null}
                </BlockStack>
              </Box>)}
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <Text as="p" fontWeight="semibold">Cart total: {testTotal.toFixed(2)} {testCurrency}</Text>
              </InlineStack>
              <InlineStack align="end" gap="200">
                <Button url={data.dashboardHref} disabled={submitting}>Back to dashboard</Button>
                <Button submit variant="primary" loading={submitting} disabled={submitting || picking || !testItems.length || !testName.trim() || !testPhone.trim()}>Start test call</Button>
              </InlineStack>
            </BlockStack>
          </Form>
    </Card>
  </Page>;
}
