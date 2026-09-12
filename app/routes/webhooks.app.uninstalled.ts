import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
export async function action({request}:ActionFunctionArgs) {
  const {shop,topic}=await authenticate.webhook(request);
  if(topic!=="APP_UNINSTALLED")return new Response("Ignored",{status:200});
  // Stop contact immediately. Keep provider identifiers until shop/redact can erase external copies.
  await db.$transaction(async tx=>{
    await tx.session.deleteMany({where:{shop}});
    await tx.settings.updateMany({where:{shop},data:{enabled:false}});
    await tx.callJob.updateMany({where:{shop,status:"QUEUED"},data:{status:"CANCELED",outcome:"APP_UNINSTALLED"}});
    await tx.shopBilling.updateMany({where:{shop},data:{status:"CANCELLED",subscriptionId:null,usageLineItemId:null,recurringLineItemId:null,pendingPlan:null}});
  });
  return new Response("OK",{status:200});
}
