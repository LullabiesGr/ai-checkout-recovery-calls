import db from "../db.server";
import { checkoutItems, checkoutName, mergeCheckoutItems, objectData } from "./checkoutData.shared";

type AdminClient = { graphql: (query: string, options?: any) => Promise<any> };

type CheckoutForEnrichment = {
  checkoutId: string;
  token?: string | null;
  customerName?: string | null;
  itemsJson?: string | null;
  raw?: string | null;
};

const text = (value: any) => typeof value === "string" ? value.trim() : "";

function gid(type: "Customer" | "Product" | "ProductVariant", value: any): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/")) return raw;
  const numeric = raw.match(/\d+/)?.[0];
  return numeric ? `gid://shopify/${type}/${numeric}` : null;
}

function parseItems(value: any): any[] {
  const parsed = objectData(value);
  return Array.isArray(parsed) ? parsed : [];
}

export function checkoutNeedsPresentationEnrichment(row: CheckoutForEnrichment): boolean {
  if (!text(row.customerName)) return true;
  const items = parseItems(row.itemsJson || checkoutItems(row.raw));
  return items.some((item: any) => !text(item?.image) && !text(item?.imageUrl));
}

function checkoutKeys(row: CheckoutForEnrichment): string[] {
  const raw = objectData(row.raw);
  return [row.checkoutId, row.token, raw?.token, raw?.cart_token, raw?.id]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function remoteCheckoutKeys(node: any): string[] {
  const values = [node?.id, String(node?.id ?? "").split("/").pop()];
  try {
    const url = new URL(String(node?.abandonedCheckoutUrl ?? ""));
    values.push(url.pathname.match(/\/checkouts\/(?:cn\/)?([^/]+)/)?.[1]);
  } catch {}
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

function nodeImage(node: any): string | null {
  return text(node?.image?.url) ||
    text(node?.featuredMedia?.preview?.image?.url) ||
    text(node?.product?.featuredMedia?.preview?.image?.url) || null;
}

/**
 * Checkout webhooks intentionally omit some protected/presentation data, most
 * notably product images. Resolve those fields with the store's offline Admin
 * session and persist them so every UI route stays fast afterwards.
 */
export async function enrichCheckoutPresentation(params: {
  admin: AdminClient;
  shop: string;
  checkouts: CheckoutForEnrichment[];
}) {
  const rows = params.checkouts.slice(0, 50);
  if (!rows.length) return new Map<string, { customerName: string | null; itemsJson: string | null }>();

  const ids = new Set<string>();
  for (const row of rows) {
    const raw = objectData(row.raw);
    const customerId = gid("Customer", raw?.customer?.admin_graphql_api_id ?? raw?.customer?.id);
    if (customerId) ids.add(customerId);
    for (const item of parseItems(row.itemsJson || checkoutItems(raw))) {
      const productId = gid("Product", item?.productId ?? item?.product_id);
      const variantId = gid("ProductVariant", item?.variantId ?? item?.variant_id);
      if (productId) ids.add(productId);
      if (variantId) ids.add(variantId);
    }
  }

  const query = `
    query CartEchoCheckoutPresentation($ids: [ID!]!, $first: Int!) {
      nodes(ids: $ids) {
        __typename
        id
        ... on Customer {
          firstName
          lastName
          displayName
          defaultAddress { firstName lastName name }
        }
        ... on Product {
          featuredMedia { preview { image { url altText } } }
        }
        ... on ProductVariant {
          image { url altText }
          product { featuredMedia { preview { image { url altText } } } }
        }
      }
      abandonedCheckouts(first: $first, reverse: true) {
        edges {
          node {
            id
            abandonedCheckoutUrl
            shippingAddress { firstName lastName name }
            billingAddress { firstName lastName name }
            customer {
              id
              firstName
              lastName
              displayName
              defaultAddress { firstName lastName name }
            }
            lineItems(first: 20) {
              edges {
                node {
                  title quantity variantTitle sku
                  image { url altText }
                  product { id featuredMedia { preview { image { url altText } } } }
                  variant {
                    id image { url altText }
                    product { id featuredMedia { preview { image { url altText } } } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await params.admin.graphql(query, {
    variables: { ids: Array.from(ids), first: Math.max(10, Math.min(50, rows.length * 3)) },
  });
  const json = typeof (response as any)?.json === "function" ? await (response as any).json() : response;
  const nodes = Array.isArray(json?.data?.nodes) ? json.data.nodes.filter(Boolean) : [];
  const remote = Array.isArray(json?.data?.abandonedCheckouts?.edges)
    ? json.data.abandonedCheckouts.edges.map((edge: any) => edge?.node).filter(Boolean)
    : [];

  const nodeById = new Map(nodes.map((node: any) => [String(node.id), node]));
  const result = new Map<string, { customerName: string | null; itemsJson: string | null }>();

  for (const row of rows) {
    const raw = objectData(row.raw);
    const keys = new Set(checkoutKeys(row));
    const matchingCheckout = remote.find((node: any) => remoteCheckoutKeys(node).some((key) => keys.has(key))) ?? null;
    const customerId = gid("Customer", raw?.customer?.admin_graphql_api_id ?? raw?.customer?.id);
    const customerNode = customerId ? nodeById.get(customerId) : null;
    const customerName = row.customerName || checkoutName(raw) || checkoutName(matchingCheckout) || checkoutName({ customer: customerNode });

    let itemsJson = mergeCheckoutItems(
      matchingCheckout ? checkoutItems(matchingCheckout) : null,
      row.itemsJson || checkoutItems(raw),
    ) ?? null;

    const items = parseItems(itemsJson);
    const enrichedItems = items.map((item: any) => {
      if (text(item?.image) || text(item?.imageUrl)) return item;
      const variantId = gid("ProductVariant", item?.variantId ?? item?.variant_id);
      const productId = gid("Product", item?.productId ?? item?.product_id);
      const image = nodeImage(variantId ? nodeById.get(variantId) : null) || nodeImage(productId ? nodeById.get(productId) : null);
      return image ? { ...item, image } : item;
    });
    itemsJson = enrichedItems.length ? JSON.stringify(enrichedItems) : itemsJson;

    if (customerName !== row.customerName || itemsJson !== row.itemsJson) {
      await db.checkout.updateMany({
        where: { shop: params.shop, checkoutId: row.checkoutId },
        data: {
          customerName: customerName || undefined,
          itemsJson: itemsJson || undefined,
        },
      });
    }
    result.set(row.checkoutId, { customerName: customerName || null, itemsJson });
  }

  return result;
}
