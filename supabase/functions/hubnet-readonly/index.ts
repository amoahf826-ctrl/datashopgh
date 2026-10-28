import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in is required." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const hubnetBase = Deno.env.get("HUBNET_API_BASE_URL")?.trim().replace(/\/+$/, "");
  if (!supabaseUrl || !anonKey) return json(503, { error: "Supabase function auth is not configured." });

  const supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session is invalid or expired." });

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (profileError) return json(503, { error: "Could not verify administrator access." });
  if (profile?.role !== "admin") return json(403, { error: "Administrator access is required." });

  if (!hubnetToken || !hubnetBase) {
    return json(503, { error: "Hubnet server secrets are not configured." });
  }

  let base: URL;
  try {
    base = new URL(hubnetBase);
  } catch {
    return json(503, { error: "HUBNET_API_BASE_URL must be a valid HTTPS URL." });
  }
  if (base.protocol !== "https:" || base.hostname !== "console.hubnet.app" || base.username || base.password || base.search || base.hash) {
    return json(503, { error: "Hubnet API base must use the verified console.hubnet.app HTTPS origin." });
  }

  let body: { operation?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  if (body.operation !== "balance") return json(400, { error: "Only the read-only balance operation is enabled." });

  const tokenHeader = /^Bearer\s+/i.test(hubnetToken) ? hubnetToken : `Bearer ${hubnetToken}`;
  try {
    const upstream = await fetch(`${hubnetBase}/live/api/context/business/transaction/check_balance`, {
      method: "GET",
      headers: { token: tokenHeader, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await upstream.json().catch(() => null);
    const envelope = payload?.response ?? payload;
    const data = envelope?.data ?? payload?.data ?? {};
    return json(upstream.status, {
      success: upstream.ok && (envelope?.status === "success" || payload?.status === "success"),
      httpStatus: upstream.status,
      message: data?.response_msg ?? envelope?.message ?? "Hubnet response received.",
      walletBalance: data?.wallet_balance ?? null,
    });
  } catch {
    return json(502, { error: "Hubnet balance check failed. No order was submitted." });
  }
});
