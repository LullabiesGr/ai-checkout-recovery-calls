import { parseTestCallInput } from "./testCall.shared";
export const TEST_SHOP_QUERY = `query TestShop { shop { name currencyCode } }`;
export const TEST_VARIANTS_QUERY = `query TestVariants($ids:[ID!]!) { shop { currencyCode } nodes(ids:$ids) { ... on ProductVariant { id title price product { id title status } } } }`;
type Admin = { graphql: (query: string, options?: any) => Promise<any> };
export async function resolveTestCatalog(admin: Admin, fd: { get(name: string): unknown }) {
  let selected: any;
  try { selected = JSON.parse(String(fd.get("items") ?? "")); } catch { throw new Error("Select products from your store."); }
  if (!Array.isArray(selected) || !selected.length || selected.length > 10) throw new Error("Select between 1 and 10 product variants.");
  const ids = selected.map(item => String(item?.variantId ?? ""));
  if (new Set(ids).size !== ids.length || ids.some(id => !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id))) throw new Error("Select valid product variants from your store.");
  const response = await admin.graphql(TEST_VARIANTS_QUERY, { variables: { ids } });
  const body = await response.json();
  if (body.errors?.length || !body.data?.shop || !Array.isArray(body.data?.nodes)) throw new Error("Product access is unavailable. Reopen the app and approve product access if Shopify requests it.");
  const rows = new Map<string, any>(body.data.nodes.filter(Boolean).map((node: any) => [node.id, node]));
  const items = selected.map((item: any) => {
    const variant = rows.get(item.variantId);
    if (!variant || variant.product?.status !== "ACTIVE") throw new Error("A selected product is no longer available in this store. Select your products again.");
    return { id: variant.id, variantId: variant.id, productId: variant.product.id,
      title: variant.title === "Default Title" ? variant.product.title : `${variant.product.title} — ${variant.title}`,
      quantity: Number(item.quantity), price: variant.price };
  });
  const currency = String(body.data.shop.currencyCode);
  const parsed = parseTestCallInput({ get: name => name === "items" ? JSON.stringify(items) : fd.get(name) }, { catalogCurrency: currency });
  const validated = JSON.parse(parsed.itemsJson);
  return { ...parsed, itemsJson: JSON.stringify(items.map((item, index) => ({ ...item, price: validated[index].price }))) };
}
