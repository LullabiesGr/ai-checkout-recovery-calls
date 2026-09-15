import { useAppBridge } from "@shopify/app-bridge-react";
import { TEST_SHOP_QUERY } from "../lib/testCatalog.server";
import { useState } from "react";
import { randomUUID } from "node:crypto";
import { useLoaderData, useActionData, useNavigation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { Page, Card, BlockStack, Text, Banner, FormLayout, TextField, Thumbnail, Box, InlineGrid, InlineStack, Button } from "@shopify/polaris";
import { Form } from "react-router";
import { authenticate } from "../shopify.server";
import { action as submitTestCall } from "./app.dashboard";
export { ErrorBoundary, headers } from "./app.dashboard";
export const action = submitTestCall;
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
              <Text as="p">The agent uses your current automation settings and the customer and cart details below. This places a real call to your test number and uses one attempt. It does not create a Shopify order.</Text>
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
