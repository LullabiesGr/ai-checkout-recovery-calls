import { createHash, createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "../db.server";
import { supabaseAdmin } from "./supabase.server";
import { customerMatches, normalizeId, parseObject, privacyIdentityKeys, type PrivacyPayload } from "./privacy.shared";

const DAY = 86400000;
const TOPICS = ["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"];
function digest(shop: string, key: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Privacy signing configuration unavailable");
  return createHmac("sha256", secret).update(`${shop}:${key}`).digest("hex");
}
export async function isPrivacySuppressed(shop: string, value: unknown, kind: "checkout" | "order" = "checkout") {
  const row = parseObject(value), raw = parseObject(row.raw || row);
  const keys = privacyIdentityKeys({customer: {id: raw.customer?.id ?? raw.customer_id,
    email: row.email ?? raw.email ?? raw.customer?.email, phone: row.phone ?? raw.phone ?? raw.customer?.phone}});
  const id = normalizeId(row.checkoutId ?? row.orderId ?? raw.id);
  if (id) keys.push(`${kind}:${id}`);
  if (!keys.length) return false;
  return !!await db.privacySuppression.findFirst({where: {shop, digest: {in: keys.map(k => digest(shop,k))}, expiresAt: {gt: new Date()}}});
}
export async function acceptPrivacyRequest(shop: string, topic: string, payload: PrivacyPayload, webhookId: string) {
  if (!TOPICS.includes(topic)) throw new Error("Unsupported privacy topic");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || payload.shop_domain !== shop) {
    throw new Error("Invalid privacy shop");
  }
  const event = topic === "CUSTOMERS_DATA_REQUEST" && payload.data_request?.id
    ? String(payload.data_request.id) : webhookId;
  if (!event) throw new Error("Missing webhook identifier");
  const id = createHash("sha256").update(`${shop}:${topic}:${event}`).digest("hex");
  return db.$transaction(async tx => {
    const row = await tx.privacyRequest.upsert({where:{id},update:{},create:{id,shop,topic,payload:payload as Prisma.InputJsonValue}});
    if (topic === "CUSTOMERS_REDACT") {
      for (const key of privacyIdentityKeys(payload)) {
        const hash = digest(shop,key);
        await tx.privacySuppression.upsert({where:{shop_digest:{shop,digest:hash}},update:{expiresAt:new Date(Date.now()+30*DAY)},create:{shop,digest:hash,expiresAt:new Date(Date.now()+30*DAY)}});
      }
    }
    return row;
  });
}

async function matchingData(shop: string, payload: PrivacyPayload, all: boolean) {
  const orders: Awaited<ReturnType<typeof db.order.findMany>> = [];
  const checkouts: Awaited<ReturnType<typeof db.checkout.findMany>> = [];
  const calls: Awaited<ReturnType<typeof db.callJob.findMany>> = [];
  const requested = new Set([...(payload.orders_requested ?? []), ...(payload.orders_to_redact ?? [])].map(normalizeId));
  let cursor: string | undefined;
  do {
    const page = await db.order.findMany({where:{shop},orderBy:{id:"asc"},take:500,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    orders.push(...page.filter(r=>all || requested.has(normalizeId(r.orderId)) || customerMatches(r,payload)));
    cursor=page.length===500?page[page.length-1].id:undefined;
  } while(cursor);
  const checkoutIds = new Set(orders.map(o=>o.checkoutId).filter(Boolean));
  const checkoutTokens = new Set(orders.map(o=>o.checkoutToken).filter(Boolean));
  do {
    const page = await db.checkout.findMany({where:{shop},orderBy:{id:"asc"},take:500,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    checkouts.push(...page.filter(r=>all || customerMatches(r,payload) || checkoutIds.has(r.checkoutId) || (!!r.token && checkoutTokens.has(r.token))));
    cursor=page.length===500?page[page.length-1].id:undefined;
  } while(cursor);
  checkouts.forEach(c=>checkoutIds.add(c.checkoutId));
  do {
    const page = await db.callJob.findMany({where:{shop},orderBy:{id:"asc"},take:500,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    calls.push(...page.filter(r=>all || checkoutIds.has(r.checkoutId) || customerMatches(r,payload)));
    cursor=page.length===500?page[page.length-1].id:undefined;
  } while(cursor);
  return {orders,checkouts,calls};
}

async function externalSummaries(shop: string, callIds: string[], jobIds: string[], erase: boolean, all: boolean) {
  if (!process.env.SUPABASE_URL && !process.env.SUPABASE_SERVICE_ROLE_KEY) return [];
  const sb=supabaseAdmin();
  const rows: Record<string,unknown>[]=[];
  // Shop filter is mandatory. Missing/view-only schemas fail visibly instead of claiming erasure.
  if(all) {
    if(erase) { const r=await sb.from("vapi_call_summaries").delete().eq("shop",shop); if(r.error) throw new Error("Supabase summary deletion needs review"); }
    return rows;
  }
  for(const [column,ids] of [["call_id",callIds],["call_job_id",jobIds]] as const) {
    for(let i=0;i<ids.length;i+=100) {
      const query=erase?sb.from("vapi_call_summaries").delete():sb.from("vapi_call_summaries").select("*");
      const r=await query.eq("shop",shop).in(column,ids.slice(i,i+100));
      if(r.error) throw new Error("Supabase privacy operation needs review");
      if(r.data) rows.push(...r.data);
    }
  }
  return rows;
}

export async function processPrivacyRequest(id: string) {
  const now=new Date();
  const initial=await db.privacyRequest.findUniqueOrThrow({where:{id}});
  const claimed=await db.$transaction(async tx=>{
    // pg_advisory_xact_lock returns PostgreSQL void. Select a supported integer instead so Prisma can deserialize it.
    await tx.$queryRaw<Array<{ locked: number }>>`SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtext(${`privacy:${initial.shop}`}))`;
    if(await tx.privacyRequest.findFirst({where:{shop:initial.shop,id:{not:id},status:"PROCESSING",lockedUntil:{gt:now}}}))return {count:0};
    return tx.privacyRequest.updateMany({where:{id,status:{in:["PENDING","FAILED","PROCESSING"]},OR:[{lockedUntil:null},{lockedUntil:{lt:now}}]},
      data:{status:"PROCESSING",lockedUntil:new Date(Date.now()+10*60*1000),attempts:{increment:1},error:null}});
  });
  if(!claimed.count)return;
  const request=await db.privacyRequest.findUniqueOrThrow({where:{id}});
  const shop=request.shop, payload=parseObject(request.payload) as PrivacyPayload, all=request.topic==="SHOP_REDACT";
  try {
    // A new installation must not be deleted by a late shop/redact for the old installation.
    if(all && await db.session.count({where:{shop}})) {
      await db.privacyRequest.update({where:{id},data:{status:"COMPLETED",payload:Prisma.DbNull,completedAt:now,lockedUntil:null,error:"Skipped: app is installed again"}});
      return;
    }
    const data=await matchingData(shop,payload,all);
    const callIds=data.calls.map(c=>c.providerCallId).filter((v):v is string=>!!v);
    if(request.topic==="CUSTOMERS_DATA_REQUEST") {
      const summaries=await externalSummaries(shop,callIds,data.calls.map(c=>c.id),false,false);
      await db.privacyRequest.update({where:{id},data:{status:"READY",report:JSON.parse(JSON.stringify({additionalRecordsReview:"Contact CartEcho support to include any processor-held or support-message records not present in this export.",customer:payload.customer,orders:data.orders,checkouts:data.checkouts,calls:data.calls,summaries})),
        payload:Prisma.DbNull,completedAt:now,lockedUntil:null,expiresAt:new Date(Date.now()+30*DAY)}});
      return;
    }
    // Cancel first; keep identifiers until every automatic deletion succeeds so retries can finish.
    await db.callJob.updateMany({where:{shop,id:{in:data.calls.map(c=>c.id)}},data:{status:"CANCELED",outcome:"PRIVACY_ERASURE_PENDING"}});
    for(const c of data.checkouts) {
      const hash=digest(shop,`checkout:${normalizeId(c.checkoutId)}`);
      await db.privacySuppression.upsert({where:{shop_digest:{shop,digest:hash}},update:{expiresAt:new Date(Date.now()+30*DAY)},create:{shop,digest:hash,expiresAt:new Date(Date.now()+30*DAY)}});
    }
    for(const callId of callIds) {
      if(!process.env.VAPI_API_KEY) throw new Error("Vapi deletion credentials unavailable");
      const r=await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`,{method:"DELETE",headers:{Authorization:`Bearer ${process.env.VAPI_API_KEY}`,"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(15000)});
      if(!r.ok && r.status!==404)throw new Error(`Vapi deletion failed (${r.status})`);
    }
    await externalSummaries(shop,callIds,data.calls.map(c=>c.id),true,all);
    if(all && process.env.SUPABASE_URL) {
      const sb=supabaseAdmin();
      const threads=await sb.from("support_threads").select("id").eq("shop",shop);
      if(threads.error)throw new Error("Support thread lookup failed");
      for(const thread of threads.data ?? []) {
        const r=await sb.from("support_messages").delete().eq("thread_id",thread.id);
        if(r.error)throw new Error("Support message deletion failed");
      }
      const r=await sb.from("support_threads").delete().eq("shop",shop);
      if(r.error)throw new Error("Support thread deletion failed");
    }
    // Preserve a minimal provider worklist, not transcripts or phone numbers, for residual processor records.
    const smsMessageIds=data.calls.map(c=>parseObject(parseObject(c.analysisJson).offer).smsMessageSid).filter(Boolean).map(String);
    const processorReview = callIds.length>0 || smsMessageIds.length>0 || Boolean(process.env.SUPABASE_URL);
    await db.$transaction(async tx=>{
      await tx.callCharge.deleteMany({where:{shop,...(!all?{callJobId:{in:data.calls.map(c=>c.id)}}:{})}});
      await tx.callJob.deleteMany({where:{shop,...(!all?{id:{in:data.calls.map(c=>c.id)}}:{})}});
      await tx.checkout.deleteMany({where:{shop,...(!all?{id:{in:data.checkouts.map(c=>c.id)}}:{})}});
      await tx.order.deleteMany({where:{shop,...(!all?{id:{in:data.orders.map(c=>c.id)}}:{})}});
      // Any older export could contain erased personal data. Invalidate exports for this shop.
      await tx.privacyRequest.updateMany({where:{shop,topic:"CUSTOMERS_DATA_REQUEST"},data:{report:Prisma.DbNull,payload:Prisma.DbNull,status:"EXPIRED"}});
      if(all) {
        await tx.settings.deleteMany({where:{shop}});
        await tx.session.deleteMany({where:{shop}});
        await tx.shopBilling.deleteMany({where:{shop}});
        await tx.billingCouponRedemption.deleteMany({where:{shop}});
        await tx.supportInquiry.deleteMany({where:{shop}});
        await tx.privacySuppression.deleteMany({where:{shop}});
        await tx.privacyRequest.deleteMany({where:{shop,id:{not:id}}});
      }
      await tx.privacyRequest.update({where:{id},data:{payload:Prisma.DbNull,lockedUntil:null,status:processorReview?"REVIEW_REQUIRED":"COMPLETED",completedAt:processorReview?null:now,
        report:processorReview?{providerCallIds:callIds,smsMessageIds,check:"Confirm customer references in support messages, SMS-provider records, raw webhook/AI logs, backups and any external automation copies are erased under processor retention policies."}:Prisma.DbNull}});
    });
  } catch {
    await db.privacyRequest.update({where:{id},data:{status:"FAILED",lockedUntil:null,error:"Privacy processing could not finish. Check provider access and database schema; retry this request."}});
  }
}
export async function processPrivacyQueue(shop?: string) {
  await db.privacyRequest.updateMany({where:{expiresAt:{lt:new Date()},status:"READY"},data:{status:"EXPIRED",report:Prisma.DbNull,payload:Prisma.DbNull}});
  await db.privacySuppression.deleteMany({where:{expiresAt:{lt:new Date()}}});
  const pending=await db.privacyRequest.findMany({where:{...(shop?{shop}:{}),status:{in:["PENDING","FAILED","PROCESSING"]},attempts:{lt:100},OR:[{lockedUntil:null},{lockedUntil:{lt:new Date()}}]},orderBy:{createdAt:"asc"},take:5,select:{id:true}});
  for(const r of pending)await processPrivacyRequest(r.id);
}
