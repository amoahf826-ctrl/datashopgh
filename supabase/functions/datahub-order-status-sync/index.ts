import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
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

type DeliveryStatus = "delivered" | "failed" | "processing";
function normalizeStatus(value: unknown): DeliveryStatus | null {
  const status = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(status)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(status)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(status)) return "processing";
  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in to refresh order status." });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = secret("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = secret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const dataHubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
  if (!url || !anonKey || !serviceKey || !dataHubKey) {
    return json(503, { error: "DataHub order status is not configured." });
  }

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session expired. Sign in again." });
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: profile } = await service.from("profiles").select("role").eq("id", authData.user.id).maybeSingle();
  let query = service.from("orders")
    .select("id,delivery_reference,provider_transaction_id,payment_reference,delivery_status,last_provider_status_checked_at")
    .eq("is_demo", false).eq("payment_status", "successful").eq("delivery_provider", "datahub")
    .in("delivery_status", ["queued", "processing", "unknown"])
    .order("last_provider_status_checked_at", { ascending: true, nullsFirst: true }).limit(40);
  if (profile?.role !== "admin") query = query.or(`user_id.eq.${authData.user.id},referred_by_agent_id.eq.${authData.user.id}`);
  const { data: orders, error } = await query;
  if (error) return json(500, { error: "Pending DataHub orders could not be loaded." });

  let updated = 0;
  const queue = [...(orders ?? [])];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length) {
      const order = queue.shift()!;
      if (!order.delivery_reference) continue;
      try {
        const providerReference = String(order.provider_transaction_id ?? "").trim();
        const lookup = new URL("https://user.datahubgh.com/api/external/order-status");
        if (/^\d+$/.test(providerReference)) lookup.searchParams.set("orderNumber", providerReference);
        else lookup.searchParams.set("reference", providerReference || order.delivery_reference);
        const response = await fetch(lookup, {
          headers: { "X-API-Key": dataHubKey, Accept: "application/json" },
          signal: AbortSignal.timeout(9000),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success !== true) continue;
        const status = normalizeStatus(payload?.data?.status);
        if (!status || status === order.delivery_status) continue;
        const { error: updateError } = await service.rpc("update_live_order_delivery", {
          p_reference: order.delivery_reference,
          p_delivery_status: status,
          p_provider_transaction_id: providerReference || null,
        });
        if (updateError) continue;
        if (status === "failed" && String(order.payment_reference ?? "").startsWith("WALLET-")) {
          await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: order.delivery_reference });
        }
        updated++;
      } catch {
        // Leave uncertain or temporarily unreachable provider results unchanged; the next refresh retries lookup only.
      } finally {
        await service.from("orders").update({ last_provider_status_checked_at: new Date().toISOString() }).eq("id", order.id);
      }
    }
  });
  await Promise.all(workers);
  return json(200, { success: true, checked: orders?.length ?? 0, updated });
});
