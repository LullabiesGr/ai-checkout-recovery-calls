import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { acceptPrivacyRequest } from "../lib/privacy.server";
import { parseObject } from "../lib/privacy.shared";
export async function action({ request }: ActionFunctionArgs) {
  if(request.method!=="POST")return new Response("Method not allowed",{status:405});
  // Shopify's verifier checks the raw body and HMAC before any database write, even after uninstall.
  const {shop,topic,payload}=await authenticate.webhook(request);
  if(!["CUSTOMERS_DATA_REQUEST","CUSTOMERS_REDACT","SHOP_REDACT"].includes(String(topic)))return new Response("Unsupported topic",{status:400});
  const data=parseObject(payload);
  if(data.shop_domain!==shop)return new Response("Invalid shop",{status:400});
  const eventId=request.headers.get("x-shopify-event-id")||request.headers.get("x-shopify-webhook-id")||String(data.data_request?.id||"");
  if(!eventId)return new Response("Missing event identifier",{status:400});
  await acceptPrivacyRequest(shop,String(topic),data,eventId);
  return new Response("OK",{status:200});
}
export function loader(){return new Response("Method not allowed",{status:405});}
