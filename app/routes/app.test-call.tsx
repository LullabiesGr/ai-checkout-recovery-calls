import { useState } from "react";
import { randomUUID } from "node:crypto";
import { useLoaderData, useActionData, useNavigation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { Page, Card, BlockStack, Text, Banner, FormLayout, TextField, Select, Box, InlineGrid, InlineStack, Button } from "@shopify/polaris";
import { Form } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopDisplayName } from "../callProvider.server";
import { action as submitTestCall } from "./app.dashboard";
export { ErrorBoundary, headers } from "./app.dashboard";
export const action = submitTestCall;
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return { testCallId: randomUUID(), storeName: await getShopDisplayName(session.shop), dashboardHref: `/app/dashboard${new URL(request.url).search}` };
}
export default function TestCallRoute() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [testPhone, setTestPhone] = useState("");
  const [testName, setTestName] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testCurrency, setTestCurrency] = useState("EUR");
  const [testItems, setTestItems] = useState([{ title: "", quantity: "1", price: "" }]);
  const updateItem = (index: number, field: "title" | "quantity" | "price", value: string) => setTestItems(items => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  const testTotal = testItems.reduce((total, item) => total + (Number(item.quantity) || 0) * (Number(item.price.replace(",", ".")) || 0), 0);
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  return <Page title="Test call" subtitle={`Simulate a recovery call from ${data.storeName}`} backAction={{ content: "Dashboard", url: data.dashboardHref }}>
    <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="create_test_call" />
            <input type="hidden" name="testCallId" value={data.testCallId} />
            <input type="hidden" name="items" value={JSON.stringify(testItems)} />
            <BlockStack gap="400">
              <Text as="p">The agent uses your current automation settings and the customer and cart details below. This places a real call to your test number and uses one attempt. It does not create a Shopify order.</Text>
              {result ? <Banner tone={result.ok ? "success" : "critical"}><p>{result.message}</p></Banner> : null}
              <FormLayout>
                <TextField label="Customer name" name="customerName" value={testName} onChange={setTestName} autoComplete="name" requiredIndicator disabled={submitting} />
                <TextField label="Your test phone number" type="tel" name="phone" value={testPhone} onChange={setTestPhone} autoComplete="tel" placeholder="+306900000000" helpText="Include the country code." requiredIndicator disabled={submitting} />
                <TextField label="Email (optional)" type="email" name="email" value={testEmail} onChange={setTestEmail} autoComplete="email" disabled={submitting} />
                <Select label="Currency" name="currency" options={["EUR", "USD", "GBP", "CAD", "AUD"]} value={testCurrency} onChange={setTestCurrency} disabled={submitting} />
              </FormLayout>
              <Text as="h3" variant="headingSm">Cart products</Text>
              {testItems.map((item, index) => <Box key={index} padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="300">
                  <TextField label={`Product ${index + 1}`} value={item.title} onChange={value => updateItem(index, "title", value)} autoComplete="off" disabled={submitting} />
                  <InlineGrid columns={2} gap="300">
                    <TextField label="Quantity" type="number" min={1} max={1000} value={item.quantity} onChange={value => updateItem(index, "quantity", value)} autoComplete="off" disabled={submitting} />
                    <TextField label="Unit price" type="number" min={0.01} step={0.01} suffix={testCurrency} value={item.price} onChange={value => updateItem(index, "price", value)} autoComplete="off" disabled={submitting} />
                  </InlineGrid>
                  {testItems.length > 1 ? <Button tone="critical" variant="plain" disabled={submitting} onClick={() => setTestItems(items => items.filter((_, i) => i !== index))}>Remove product</Button> : null}
                </BlockStack>
              </Box>)}
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <Button disabled={submitting || testItems.length >= 10} onClick={() => setTestItems(items => [...items, { title: "", quantity: "1", price: "" }])}>Add product</Button>
                <Text as="p" fontWeight="semibold">Cart total: {testTotal.toFixed(2)} {testCurrency}</Text>
              </InlineStack>
              <InlineStack align="end" gap="200">
                <Button url={data.dashboardHref} disabled={submitting}>Back to dashboard</Button>
                <Button submit variant="primary" loading={submitting} disabled={submitting || !testName.trim() || !testPhone.trim()}>Start test call</Button>
              </InlineStack>
            </BlockStack>
          </Form>
    </Card>
  </Page>;
}
