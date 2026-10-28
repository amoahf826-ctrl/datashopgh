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
  const apiKey = Deno.env.get("GHANADATAHUB_API_KEY")?.trim();
  if (!supabaseUrl || !anonKey) return json(503, { error: "Supabase function auth is not configured." });
  if (!apiKey) return json(503, { error: "GHANADATAHUB_API_KEY is not configured in Edge Function secrets." });

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

  let body: { operation?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (body.operation !== "verify") return json(400, { error: "Only the read-only API verification operation is enabled." });

  try {
    const headers = { "x-api-key": apiKey, Accept: "application/json" };
    const [balanceResponse, networksResponse] = await Promise.all([
      fetch("https://ghanadatahub.net/api/v1/balance", { headers, signal: AbortSignal.timeout(15000) }),
      fetch("https://ghanadatahub.net/api/v1/networks", { headers, signal: AbortSignal.timeout(15000) }),
    ]);
    const [balancePayload, networksPayload] = await Promise.all([
      balanceResponse.json().catch(() => null),
      networksResponse.json().catch(() => null),
    ]);
    const ok = balanceResponse.ok && networksResponse.ok && balancePayload?.success === true && networksPayload?.success === true;
    if (!ok) {
      const status = !balanceResponse.ok ? balanceResponse.status : networksResponse.status;
      const message = balancePayload?.message ?? networksPayload?.message ?? "GhanaDataHub rejected the API check.";
      return json(200, { success: false, httpStatus: status, message: String(message).slice(0, 240) });
    }
    const rawNetworks = Array.isArray(networksPayload.networks) ? networksPayload.networks : [];
    const networks = rawNetworks.map((network: Record<string, unknown>) => ({
      id: network.id,
      name: network.name,
      slug: network.slug,
      bundles_count: network.bundles_count,
    }));
    return json(200, {
      success: true,
      balance: balancePayload.balance ?? null,
      currency: balancePayload.currency ?? "GHS",
      networks,
    });
  } catch {
    return json(502, { error: "GhanaDataHub could not be reached. No order was submitted." });
  }
});
