import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyConfiguredNumber } from "../_shared/numberVerification.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });
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
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(503, { error: "Number verification is not configured." });
  if (request.headers.get("apikey") !== anonKey) return json(401, { error: "Invalid request." });

  let body: { phone?: unknown; agent_referral_code?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const referralCode = typeof body.agent_referral_code === "string" ? body.agent_referral_code.trim().toUpperCase() : "";
  if (typeof body.phone !== "string" || !/^0\d{9}$/.test(body.phone) ||
      referralCode.length > 80) {
    return json(400, { error: "Enter a valid 10-digit Ghanaian phone number." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (referralCode) {
    const { data: agent, error: agentError } = await service.from("agent_accounts")
      .select("user_id").eq("is_active", true).eq("referral_code", referralCode).maybeSingle();
    if (agentError) return json(503, { error: "Could not verify this agent storefront." });
    if (!agent) return json(403, { error: "This agent storefront is not active." });
  }

  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${referralCode || "main-store"}`));
  const rateKey = `number-verification:${Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, "0")).join("")}`;
  const { data: allowed, error: rateError } = await service.rpc("consume_public_number_verification_rate_limit", {
    p_rate_key: rateKey, p_limit: 10,
  });
  if (rateError) return json(503, { error: "Number verification is temporarily unavailable." });
  if (allowed !== true) return json(429, { error: "Too many number checks. Please wait a few minutes and try again." });

  const result = await verifyConfiguredNumber(service, body.phone);
  if ("error" in result) return json(502, { error: result.error });
  return json(200, { success: true, provider: result.provider, phone: body.phone, status: result.status });
});
