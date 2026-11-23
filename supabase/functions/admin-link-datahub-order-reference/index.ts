import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });

function secret(legacy: string, collection: string): string | undefined {
  const direct = Deno.env.get(legacy)?.trim();
  if (direct) return direct;
  try {
    const values = JSON.parse(Deno.env.get(collection) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    return Object.values(values).find((value): value is string => typeof value === "string");
  } catch { return undefined; }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return reply(401, { error: "Administrator sign-in required." });
  const url = Deno.env.get("SUPABASE_URL");
  const anon = secret("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = secret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !anon || !serviceKey) return reply(503, { error: "Order linking is not configured." });
  const auth = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData.user) return reply(401, { error: "Your session expired. Sign in again." });
  const { data: profile } = await auth.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (profile?.role !== "admin") return reply(403, { error: "Administrator access required." });
  let body: { order_id?: unknown; provider_reference?: unknown };
  try { body = await request.json(); } catch { return reply(400, { error: "Invalid JSON request." }); }
  if (typeof body.order_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.order_id) ||
      typeof body.provider_reference !== "string" || !body.provider_reference.trim() || body.provider_reference.trim().length > 180) {
    return reply(400, { error: "Provide an order ID and DataHub order number or reference." });
  }
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const reference = body.provider_reference.trim();
  const { data: order, error } = await service.from("orders")
    .select("id,delivery_provider,delivery_status,payment_status,is_demo,provider_transaction_id")
    .eq("id", body.order_id).maybeSingle();
  if (error || !order) return reply(404, { error: "Order not found." });
  if (order.is_demo || order.payment_status !== "successful" || order.delivery_provider !== "datahub" ||
      !["queued", "processing", "unknown"].includes(order.delivery_status)) {
    return reply(409, { error: "Only paid, active DataHub orders can be linked." });
  }
  if (order.provider_transaction_id && order.provider_transaction_id !== reference) {
    return reply(409, { error: "This order already has a different DataHub reference." });
  }
  const { error: updateError } = await service.from("orders")
    .update({ provider_transaction_id: reference, last_provider_status_checked_at: null })
    .eq("id", order.id);
  if (updateError) return reply(500, { error: "Could not save the DataHub reference." });
  return reply(200, { success: true, provider_reference: reference, message: "DataHub order reference linked. Refresh Orders to check its live status." });
});
