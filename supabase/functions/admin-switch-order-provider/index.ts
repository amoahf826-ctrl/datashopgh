import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const reply=(status:number,data:Record<string,unknown>)=>new Response(JSON.stringify(data),{status,headers});
function readSecret(legacy:string,collection:string):string|undefined{const value=Deno.env.get(legacy)?.trim();if(value)return value;try{const all=JSON.parse(Deno.env.get(collection)??"{}");if(typeof all.default==="string")return all.default;return Object.values(all).find((entry)=>typeof entry==="string") as string|undefined}catch{return undefined}}
function normalize(value:unknown):"delivered"|"failed"|"processing"|null{const s=String(value??"").trim().toUpperCase().replace(/[\s-]+/g,"_");if(["SUCCESS","SUCCESSFUL","DELIVERED","COMPLETED","COMPLETE"].includes(s))return "delivered";if(["FAILED","FAILURE","CANCELLED","CANCELED","REJECTED","REFUNDED"].includes(s))return "failed";if(["PENDING","QUEUED","PROCESSING","IN_PROGRESS","ACCEPTED"].includes(s))return "processing";return null}
Deno.serve(async(request)=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers});if(request.method!=="POST")return reply(405,{error:"Method not allowed."});
  const authorization=request.headers.get("Authorization");if(!authorization?.startsWith("Bearer "))return reply(401,{error:"Sign in as an administrator."});
  const url=Deno.env.get("SUPABASE_URL"),anon=readSecret("SUPABASE_ANON_KEY","SUPABASE_PUBLISHABLE_KEYS"),serviceKey=readSecret("SUPABASE_SERVICE_ROLE_KEY","SUPABASE_SECRET_KEYS");if(!url||!anon||!serviceKey)return reply(503,{error:"Provider retry service is not configured."});
  const auth=createClient(url,anon,{global:{headers:{Authorization:authorization}}});const {data:userData,error:userError}=await auth.auth.getUser();if(userError||!userData.user)return reply(401,{error:"Your session expired. Sign in again."});
  const {data:admin,error:adminError}=await auth.rpc("is_admin");if(adminError||admin!==true)return reply(403,{error:"Administrator access required."});
  let body:{order_id?:unknown;provider?:unknown};try{body=await request.json()}catch{return reply(400,{error:"Request body must be JSON."})}
  if(typeof body.order_id!=="string"||!/^[0-9a-f-]{36}$/i.test(body.order_id)||!(["datahub","hubnet"] as unknown[]).includes(body.provider))return reply(400,{error:"Choose a valid order and provider."});
  const provider=body.provider as "datahub"|"hubnet",service=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:order,error:claimError}=await service.rpc("admin_claim_provider_retry",{p_order_id:body.order_id,p_provider:provider,p_actor:userData.user.id});if(claimError||!order)return reply(409,{error:claimError?.message??"Could not safely claim this order for retry."});
  const datahubKey=readSecret("DATAHUB_API_KEY","DATAHUB_API_KEYS"),hubnetToken=Deno.env.get("HUBNET_BEARER_TOKEN")?.trim(),hubnetBase=(Deno.env.get("HUBNET_API_BASE_URL")?.trim()||"https://console.hubnet.app").replace(/\/+$/,"");
  if(provider==="datahub"&&!datahubKey||provider==="hubnet"&&!hubnetToken){await service.rpc("update_live_order_delivery",{p_reference:order.reference,p_delivery_status:"failed"});return reply(503,{error:`${provider==="hubnet"?"Hubnet":"DataHub GH"} credentials are not configured.`})}
  if(provider==="hubnet")try{const base=new URL(hubnetBase);if(base.protocol!=="https:"||base.hostname!=="console.hubnet.app"||base.username||base.password)throw new Error()}catch{await service.rpc("update_live_order_delivery",{p_reference:order.reference,p_delivery_status:"failed"});return reply(503,{error:"HUBNET_API_BASE_URL must use the verified Hubnet HTTPS origin."})}
  const size=String(order.size??"").match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i),category=`${order.category} ${order.subcategory}`.toLowerCase();
  const network=String(order.network),networkKey=network==="MTN"?(/xpress|express/.test(category)?"mtn_xpress":"YELLO"):network==="Telecel"?"TELECEL":network==="AT"?(/big[\s-]?time/.test(category)?"AT_BIGTIME":"AT_PREMIUM"):null;
  if(!size||!networkKey){await service.rpc("update_live_order_delivery",{p_reference:order.reference,p_delivery_status:"failed"});return reply(422,{error:"The order plan could not be mapped to a provider network and bundle size."})}
  const supabaseWebhook=`${url.replace(/\/+$/,"")}/functions/v1/hubnet-webhook`;
  try{
    let response:Response;
    if(provider==="datahub")response=await fetch("https://user.datahubgh.com/api/external/data-purchase",{method:"POST",headers:{"X-API-Key":datahubKey!,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({networkKey,recipient:order.phone,capacity:String(Number((Number(size[1])*(size[2].toUpperCase()==="GB"?1:.001)).toFixed(3)))}),signal:AbortSignal.timeout(15000)});
    else{
      const path=networkKey==="AT_BIGTIME"?"big-time-new-transaction":networkKey==="TELECEL"?"telecel-new-transaction":networkKey==="AT_PREMIUM"?"at-new-transaction":"mtn-new-transaction";
      const token=/^Bearer\s+/i.test(hubnetToken!)?hubnetToken!:`Bearer ${hubnetToken}`;
      response=await fetch(`${hubnetBase}/live/api/context/business/transaction/${path}`,{method:"POST",headers:{token,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({phone:order.phone,volume:String(Math.round(Number(size[1])*(size[2].toUpperCase()==="GB"?1000:1))),reference:order.reference,webhook:supabaseWebhook}),signal:AbortSignal.timeout(15000)});
    }
    const raw=await response.json().catch(()=>null),envelope=provider==="hubnet"?(raw?.response??raw):raw,data=envelope?.data??raw?.data??{},accepted=provider==="hubnet"?(envelope?.status===true||envelope?.status==="success"||raw?.success===true||raw?.status==="success"):raw?.success===true;
    if(response.ok&&accepted&&(provider==="hubnet"||typeof data.reference==="string")){
      const status=normalize(data.status??data.delivery_status??data.orderStatus??data.order_status)??"processing";
      const {error}=await service.rpc("update_live_order_delivery",{p_reference:order.reference,p_delivery_status:status,p_provider_transaction_id:data.reference??data.transaction_id??data.tracking_id??order.reference});
      if(error)return reply(500,{error:"Provider accepted the retry, but order status could not be saved. Check the order status before retrying again."});
      return reply(200,{success:true,delivery_status:status});
    }
    if(response.status>=400&&response.status<500){await service.rpc("update_live_order_delivery",{p_reference:order.reference,p_delivery_status:"failed"});return reply(502,{error:String(raw?.message??raw?.error??"The alternate provider rejected the retry." )})}
    await service.rpc("update_live_order_delivery",{p_reference:order.reference,p_delivery_status:"unknown"});return reply(202,{success:true,delivery_status:"unknown",message:"Provider response is uncertain. Check order status before taking action."});
  }catch{
    await service.rpc("update_live_order_delivery",{p_reference:order.reference,p_delivery_status:"unknown"});return reply(202,{success:true,delivery_status:"unknown",message:"Provider response is uncertain. Check order status before retrying."});
  }
});
