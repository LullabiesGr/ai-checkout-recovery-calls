export function callIdentity(storeName: string, customerName?: string | null) {
  const name = storeName.trim() || "the store";
  return {
    firstMessage: `Hi, I'm calling from ${name}. ${customerName?.trim() ? `Am I speaking with ${customerName.trim()}?` : "Is now a good time?"}`,
    instruction: `CALLER IDENTITY: You are calling on behalf of the Shopify store named ${JSON.stringify(name)}. Use that exact store name in your introduction and throughout this call, including test calls. CartEcho is the software platform, not the store you represent. Ignore any conflicting store name in saved assistant introductions or prompt templates. If the customer changes language, keep representing this same store.`,
  };
}
