import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: cors });
function readKey(legacyName: string, collectionName: string): string | undefined {
  const legacy = Deno.env.get(legacyName)?.trim();
  if (legacy) return legacy;
  try {
    const values = JSON.parse(Deno.env.get(collectionName) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !anonKey || !serviceKey) return json(503, { error: "Reports are temporarily unavailable." });
  if (request.headers.get("apikey") !== anonKey) return json(401, { error: "Invalid request." });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }

  const name = typeof body.reporter_name === "string" ? body.reporter_name.trim() : "";
  const phone = typeof body.reporter_phone === "string" ? body.reporter_phone.replace(/\D/g, "") : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const referralCode = typeof body.agent_referral_code === "string" ? body.agent_referral_code.trim().toUpperCase() : "";
  const orderId = typeof body.order_id === "string" && body.order_id ? body.order_id : null;
  if (name.length < 2 || name.length > 100 || !/^0\d{9}$/.test(phone) || subject.length < 3 || subject.length > 120 ||
      message.length < 10 || message.length > 2000 || (referralCode && referralCode.length > 80) ||
      (orderId && !/^[0-9a-f-]{36}$/i.test(orderId))) {
    return json(400, { error: "Enter your name, a valid Ghana phone number, a subject, and a report of 10 to 2,000 characters." });
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let agentId: string | null = null;
  if (referralCode) {
    const { data: agent, error } = await service.from("agent_accounts").select("user_id")
      .eq("referral_code", referralCode).eq("is_active", true).maybeSingle();
    if (error) return json(503, { error: "Could not confirm this store. Please try again." });
    if (!agent) return json(400, { error: "This store is unavailable. Return to the storefront and try again." });
    agentId = agent.user_id;
  }
  if (orderId) {
    const { data: order, error } = await service.from("orders").select("id,recipient_phone,referred_by_agent_id")
      .eq("id", orderId).maybeSingle();
    if (error) return json(503, { error: "Could not attach the report to that order." });
    if (!order || order.recipient_phone !== phone || (agentId && order.referred_by_agent_id !== agentId)) {
      return json(400, { error: "That order could not be matched to your phone number and store." });
    }
  }

  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${referralCode || "main"}`));
  const rateKey = `storefront-report:${Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("")}`;
  const { data: allowed, error: rateError } = await service.rpc("consume_storefront_report_rate_limit", { p_rate_key: rateKey });
  if (rateError) return json(503, { error: "Reports are temporarily unavailable. Please try again." });
  if (allowed !== true) return json(429, { error: "Too many reports were submitted. Please wait and try again." });

  const { error: insertError } = await service.from("storefront_customer_reports").insert({
    agent_id: agentId, order_id: orderId, reporter_name: name, reporter_phone: phone, subject, message,
  });
  if (insertError) return json(503, { error: "Your report could not be sent. Please try again later." });
  return json(200, { success: true, message: agentId ? "Your report was sent to this store’s agent." : "Your report was sent to the CheapDataBundle support team." });
});
