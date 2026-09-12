import { Prisma } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form,useLoaderData,useNavigation } from "react-router";
import { Page,Card,BlockStack,Text,Button,Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { processPrivacyQueue } from "../lib/privacy.server";
async function requireAdmin(request:Request){const {session}=await authenticate.admin(request);if(session.shop!==(process.env.PLATFORM_ADMIN_SHOP||"afterwin.myshopify.com"))throw new Response("Not found",{status:404});}
export async function loader({request}:LoaderFunctionArgs){await requireAdmin(request);return {requests:await db.privacyRequest.findMany({orderBy:{createdAt:"desc"},take:100,select:{id:true,shop:true,topic:true,status:true,createdAt:true,error:true,report:true}}),inquiries:await db.supportInquiry.findMany({where:{status:"OPEN"},orderBy:{createdAt:"asc"},take:100})};}
export async function action({request}:ActionFunctionArgs){
  await requireAdmin(request);const f=await request.formData();
  if(f.get("intent")==="close_inquiry")await db.supportInquiry.updateMany({where:{id:String(f.get("id")||"")},data:{status:"CLOSED"}});
  else if(f.get("intent")==="complete_review"){
    if(f.get("verified")!=="yes")throw new Response("Verify all processor erasure tasks first",{status:400});
    await db.privacyRequest.updateMany({where:{id:String(f.get("id")||""),status:"REVIEW_REQUIRED"},data:{status:"COMPLETED",completedAt:new Date(),report:Prisma.DbNull}});
  } else await processPrivacyQueue();
  return {ok:true};
}
export default function PrivacyAdmin(){const {requests,inquiries}=useLoaderData<typeof loader>(),nav=useNavigation();return <Page title="Privacy & public support"><BlockStack gap="400">
  <Banner tone="warning"><p>Privacy requests must be completed within the applicable deadline. REVIEW REQUIRED is not a completed erasure: check SMS providers, raw webhook/AI logs, external copies and backups. No customer export is sent automatically.</p></Banner>
  <Form method="post"><Button submit loading={nav.state!=="idle"}>Process pending privacy requests</Button></Form>
  {requests.map(r=><Card key={r.id}><BlockStack gap="200"><Text as="h2" variant="headingMd">{r.shop} — {r.topic}</Text><Text as="p">{r.status} · {new Date(r.createdAt).toLocaleDateString("en-GB")}</Text>{r.error?<Text as="p">{r.error}</Text>:null}{r.status==="REVIEW_REQUIRED"?<><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(r.report,null,2)}</pre><Form method="post"><input type="hidden" name="intent" value="complete_review"/><input type="hidden" name="id" value={r.id}/><label><input type="checkbox" name="verified" value="yes" required/> I verified completion of all external processor erasure tasks.</label><Button submit>Complete verified request</Button></Form></>:null}</BlockStack></Card>)}
  <Text as="h2" variant="headingLg">Public support messages</Text>
  {!inquiries.length?<Text as="p">No open messages.</Text>:inquiries.map(i=><Card key={i.id}><BlockStack gap="200"><Text as="h3" variant="headingMd">{i.email}</Text><Text as="p">{i.shop||"No store supplied"}</Text><p style={{whiteSpace:"pre-wrap"}}>{i.message}</p><Form method="post"><input type="hidden" name="intent" value="close_inquiry"/><input type="hidden" name="id" value={i.id}/><Button submit>Mark resolved</Button></Form></BlockStack></Card>)}
</BlockStack></Page>;}
