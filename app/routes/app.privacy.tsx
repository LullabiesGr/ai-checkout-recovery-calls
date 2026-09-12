import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { Form, useLoaderData, useNavigation, useRouteError } from "react-router";
import { Page, Card, BlockStack, Text, Button, Banner } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { processPrivacyQueue } from "../lib/privacy.server";
export async function loader({request}:LoaderFunctionArgs){
  const {session}=await authenticate.admin(request);
  const requests=await db.privacyRequest.findMany({where:{shop:session.shop},orderBy:{createdAt:"desc"},take:100,select:{id:true,topic:true,status:true,createdAt:true,expiresAt:true,error:true}});
  return {requests};
}
export async function action({request}:ActionFunctionArgs){const {session}=await authenticate.admin(request);await processPrivacyQueue(session.shop);return {ok:true};}
export default function PrivacyRequests(){const {requests}=useLoaderData<typeof loader>(),nav=useNavigation();return <Page title="Privacy requests"><BlockStack gap="400">
  <Card><BlockStack gap="300"><Text as="p">Shopify customer data and deletion requests appear here. Download requested data and provide it securely to the requester after verifying their identity. Exports expire after 30 days.</Text>
  <Form method="post"><Button submit loading={nav.state!=="idle"}>Process pending requests</Button></Form>
  <Text as="p"><a href="/privacy" target="_blank" rel="noreferrer">Privacy policy</a> · <a href="/support" target="_blank" rel="noreferrer">Contact support</a></Text></BlockStack></Card>
  {!requests.length?<Card><Text as="p">No privacy requests have been received for this store.</Text></Card>:requests.map(r=><Card key={r.id}><BlockStack gap="200"><Text as="h2" variant="headingMd">{r.topic.replaceAll("_"," ")}</Text><Text as="p">{r.status.replaceAll("_"," ")} · {new Date(r.createdAt).toLocaleDateString("en-GB")}</Text>
  {r.error?<Banner tone="warning"><p>{r.error}</p></Banner>:null}
  {r.status==="REVIEW_REQUIRED"?<Text as="p">Local erasure is complete. The CartEcho team must finish checking external processor records.</Text>:null}
  {r.status==="READY"?<Form method="post" action="/api/privacy/export" reloadDocument><input type="hidden" name="id" value={r.id}/><Button submit>Download customer data</Button></Form>:null}
  </BlockStack></Card>)}</BlockStack></Page>;}
export function ErrorBoundary(){return boundary.error(useRouteError());}
export const headers:HeadersFunction=args=>boundary.headers(args);
