import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData, useNavigation } from "react-router";
import db from "../db.server";
import { PublicPage } from "../components/PublicPage";
export const meta=()=>[{title:"CartEcho Support"}];
export async function action({request}:ActionFunctionArgs){
  if(request.method!=="POST")throw new Response("Method not allowed",{status:405});
  const expected=new URL(process.env.SHOPIFY_APP_URL || request.url).origin;
  if(request.headers.get("origin")!==expected)throw new Response("Forbidden",{status:403});
  if(Number(request.headers.get("content-length")||0)>20000)throw new Response("Too large",{status:413});
  const f=await request.formData();
  if(String(f.get("website")||""))return {ok:true,error:null};
  const email=String(f.get("email")||"").trim().toLowerCase(), message=String(f.get("message")||"").trim(), shop=String(f.get("shop")||"").trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||message.length<10||message.length>5000|| (shop&&!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)))return {ok:false,error:"Enter a valid email, store domain (if provided) and a message between 10 and 5,000 characters."};
  // Serialize submissions per email to enforce a shared rate limit across workers.
  const accepted=await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`support:${email}`}))`;
    if(await tx.supportInquiry.count({where:{email,createdAt:{gt:new Date(Date.now()-3600000)}}})>=5)return false;
    await tx.supportInquiry.create({data:{email,shop:shop||null,message}});return true;
  });
  return accepted?{ok:true,error:null}:{ok:false,error:"Too many requests. Please try again in an hour."};
}
export default function Support(){const data=useActionData<typeof action>(),nav=useNavigation();return <PublicPage title="Contact support">
  <p>For setup, billing or privacy requests, contact the CartEcho team below. Installed merchants can also use the support chat inside the app.</p>
  {data?.ok?<p role="status">Your message has been received. The team will use your email to respond.</p>:<Form method="post" style={{display:"grid",gap:16}}>
    {data?.error?<p role="alert">{data.error}</p>:null}
    <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} style={{display:"block",padding:10,width:"100%",boxSizing:"border-box"}}/></label>
    <label>Shop domain (optional)<input name="shop" placeholder="your-store.myshopify.com" maxLength={255} style={{display:"block",padding:10,width:"100%",boxSizing:"border-box"}}/></label>
    <label>Message<textarea name="message" required minLength={10} maxLength={5000} rows={7} style={{display:"block",padding:10,width:"100%",boxSizing:"border-box"}}/></label>
    <div style={{display:"none"}} aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off"/></label></div>
    <p>Do not include passwords, API keys or card details. We use this information to answer your request as described in our <a href="/privacy">privacy policy</a>.</p>
    <button type="submit" disabled={nav.state!=="idle"} style={{padding:12,background:"#5b38da",color:"white",border:0,borderRadius:8}}>{nav.state!=="idle"?"Sending…":"Send message"}</button>
  </Form>}
</PublicPage>;}
