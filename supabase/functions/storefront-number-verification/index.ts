import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  if (typeof body.phone !== "string" || !/^0\d{9}$/.test(body.phone) ||
      typeof body.agent_referral_code !== "string" || !body.agent_referral_code.trim() || body.agent_referral_code.length > 80) {
    return json(400, { error: "Enter a valid 10-digit Ghanaian number and open an active agent storefront." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: agent, error: agentError } = await service.from("agent_accounts")
    .select("user_id").eq("is_active", true).eq("referral_code", body.agent_referral_code.trim().toUpperCase()).maybeSingle();
  if (agentError) return json(503, { error: "Could not verify this agent storefront." });
  if (!agent) return json(403, { error: "This agent storefront is not active." });

  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${body.agent_referral_code.toUpperCase()}`));
  const rateKey = `number-verification:${Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, "0")).join("")}`;
  const { data: allowed, error: rateError } = await service.rpc("consume_public_number_verification_rate_limit", {
    p_rate_key: rateKey, p_limit: 10,
  });
  if (rateError) return json(503, { error: "Number verification is temporarily unavailable." });
  if (allowed !== true) return json(429, { error: "Too many number checks. Please wait a few minutes and try again." });

  const { data: setting, error: settingError } = await service.from("platform_settings")
    .select("value").eq("key", "number_verification_provider").maybeSingle();
  if (settingError) return json(503, { error: "Could not load the active number verification provider." });
  const provider = setting?.value?.provider === "hubnet" ? "hubnet" : "datahub";

  try {
    if (provider === "datahub") {
      const datahubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
      if (!datahubKey) return json(503, { error: "DataHub number verification is not configured." });
      const response = await fetch("https://user.datahubgh.com/api/external/purchases/verify-number", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": datahubKey, Accept: "application/json" },
        body: JSON.stringify({ phone: body.phone, is_ported_number: true }),
        signal: AbortSignal.timeout(20000),
      });
      const payload = await response.json().catch(() => null);
      const providerMessage = String(payload?.error ?? payload?.message ?? "");
      if (response.ok && payload?.success === true && (payload?.data?.verified === true || payload?.data?.exists === true)) {
        return json(200, { success: true, provider, phone: body.phone, status: "verified" });
      }
      if ((response.ok || response.status === 400) &&
          (payload?.data?.verified === false || payload?.data?.exists === false || /phone number not verified|not added to.*beneficiar/i.test(providerMessage))) {
        return json(200, { success: true, provider, phone: body.phone, status: "unverified" });
      }
      if (response.status === 400 && payload?.success === false) {
        return json(200, { success: true, provider, phone: body.phone, status: "invalid" });
      }
      return json(502, { error: "DataHub could not verify this number right now. Try again later." });
    }

    const token = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
    const apiBase = Deno.env.get("HUBNET_API_BASE_URL")?.trim().replace(/\/+$/, "");
    if (!token || !apiBase) return json(503, { error: "Hubnet number verification is not configured." });
    const base = new URL(apiBase);
    if (base.protocol !== "https:" || base.hostname !== "console.hubnet.app" || base.username || base.password || base.search || base.hash) {
      return json(503, { error: "Hubnet verification is not configured with the approved API host." });
    }
    const endpoint = new URL(`${apiBase}/live/api/context/business/transaction/mtn-verification`);
    endpoint.searchParams.set("number", body.phone);
    const tokenHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    const response = await fetch(endpoint, {
      method: "GET", headers: { token: tokenHeader, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const payload = await response.json().catch(() => null);
    const envelope = payload?.response ?? payload;
    const data = envelope?.data ?? payload?.data;
    const status = String(data?.status ?? "").toLowerCase();
    const responseOk = envelope?.status === true || envelope?.status === "success" || payload?.status === true || payload?.status === "success";
    if (!response.ok || !responseOk || !["verified", "unverified", "queued", "invalid"].includes(status)) {
      return json(502, { error: "Hubnet could not verify this number right now. Try again later." });
    }
    return json(200, { success: true, provider, phone: body.phone, status });
  } catch {
    return json(502, { error: "Number verification is temporarily unavailable. Please try again." });
  }
});
