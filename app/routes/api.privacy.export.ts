import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
export async function action({request}:ActionFunctionArgs){
  const {session}=await authenticate.admin(request);
  const id=String((await request.formData()).get("id")||"");
  const row=await db.privacyRequest.findFirst({where:{id,shop:session.shop,topic:"CUSTOMERS_DATA_REQUEST",status:"READY",expiresAt:{gt:new Date()}}});
  if(!row?.report)return new Response("Export unavailable",{status:404});
  return new Response(JSON.stringify(row.report,null,2),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":'attachment; filename="customer-data.json"',"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
export function loader(){return new Response("Method not allowed",{status:405});}
