export function parseTestCallInput(fd: { get(name: string): unknown }, options?: { catalogCurrency: string }) {
  const customerName = String(fd.get("customerName") ?? "").trim();
  const email = String(fd.get("email") ?? "").trim();
  const currency = String(options?.catalogCurrency ?? fd.get("currency") ?? "EUR").toUpperCase();
  if (!customerName || customerName.length > 120) throw new Error("Enter a customer name, up to 120 characters.");
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Enter a valid email address or leave it empty.");
  if (options ? !/^[A-Z]{3}$/.test(currency) : !["EUR", "USD", "GBP", "CAD", "AUD"].includes(currency)) throw new Error("Select a supported currency.");
  let items: unknown;
  try { items = JSON.parse(String(fd.get("items") ?? "")); } catch { throw new Error("Add at least one product."); }
  if (!Array.isArray(items) || !items.length || items.length > 10) throw new Error("Add between 1 and 10 products.");
  const normalized = items.map((item: any) => {
    const title = String(item?.title ?? "").trim();
    const quantity = Number(item?.quantity);
    const price = Number(String(item?.price ?? "").replace(",", "."));
    if (!title || title.length > 200 || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || !Number.isFinite(price) || (options ? price < 0 : price <= 0) || price > 100000) throw new Error("Each product needs a name, a quantity from 1 to 1,000, and a positive unit price.");
    return { title, quantity, price: Math.round(price * 100) / 100 };
  });
  const value = Math.round(normalized.reduce((total, item) => total + item.quantity * item.price, 0) * 100) / 100;
  if (value > 1000000) throw new Error("The test cart total must not exceed 1,000,000.");
  return { customerName, email: email || null, currency, value, itemsJson: JSON.stringify(normalized) };
}
