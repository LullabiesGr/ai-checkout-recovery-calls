import type { ActionFunctionArgs } from "react-router";
import twilio from "twilio";
export async function action({request}:ActionFunctionArgs){
  const token=process.env.TWILIO_AUTH_TOKEN, signature=request.headers.get("x-twilio-signature");
  if(!token || !signature)return new Response("Unauthorized",{status:401});
  const form=await request.formData();const params=Object.fromEntries([...form].map(([key,value])=>[key,String(value)]));
  const url=new URL(request.url);const base=process.env.SHOPIFY_APP_URL || process.env.APP_URL;
  if(base)url.host=new URL(base).host;
  url.protocol="https:";
  if(!twilio.validateRequest(token,signature,url.toString(),params))return new Response("Unauthorized",{status:401});
  // Delivery callbacks never log recipient numbers or message content.
  return new Response("OK",{status:200});
}
