export function shopLabelFromDomain(shop: string) {
  return shop
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(".myshopify.com", "");
}