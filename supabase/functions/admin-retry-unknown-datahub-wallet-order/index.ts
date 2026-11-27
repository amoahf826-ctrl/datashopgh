import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dataHubNetworkKey, resolveBundleRoute } from "../_shared/bundle-routing.ts";
import { dataHubOrderReference } from "../_shared/datahub-order-reference.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: cors });

function statusOf(value: unknown): "delivered" | "failed" | "processing" | null {
  const valueText = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(valueText)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(valueText)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(valueText)) return "processing";
  return null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "Use POST." });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const dataHubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
  const authorization = request.headers.get("Authorization");
  if (!url || !anon || !serviceKey || !dataHubKey) return json(503, { error: "Server configuration is incomplete." });
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Administrator sign-in required." });

  const authClient = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session expired. Sign in again." });
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: profile, error: profileError } = await service.from("profiles")
    .select("role").eq("id", authData.user.id).maybeSingle();
  if (profileError || profile?.role !== "admin") return json(403, { error: "Administrator access required." });

  let body: { order_ids?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Invalid JSON request." }); }
  const orderIds = Array.isArray(body.order_ids) ? body.order_ids : [body.order_ids];
  if (!orderIds.length || orderIds.length > 10 || orderIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    return json(400, { error: "Provide 1 to 10 valid order IDs." });
  }

  const outcomes: Record<string, unknown>[] = [];
  for (const orderId of orderIds as string[]) {
    const { data: claim, error: claimError } = await service.rpc("admin_claim_unknown_datahub_wallet_retry", {
      p_order_id: orderId, p_actor: authData.user.id,
    });
    if (claimError || !claim) {
      outcomes.push({ order_id: orderId, success: false, error: claimError?.message ?? "Could not claim order for retry." });
      continue;
    }

    const plan = { network: claim.network, category: claim.category, subcategory: claim.subcategory,
      size: claim.size, delivery_provider: "datahub", delivery_network_type: claim.delivery_network_type };
    let newReference = claim.reference as string;
    try {
      const route = resolveBundleRoute(plan, "datahub");
      const networkKey = dataHubNetworkKey(route.networkType);
      const size = String(claim.size ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
      if (!size) throw new Error("The saved bundle size is invalid.");
      const capacity = String(Number((Number(size[1]) * (size[2].toUpperCase() === "GB" ? 1 : 0.001)).toFixed(3)));
      const response = await fetch("https://user.datahubgh.com/api/external/data-purchase", {
        method: "POST",
        headers: { "X-API-Key": dataHubKey, "Content-Type": "application/json", Accept: "application/json",
          Origin: "https://cheapdatabundle.com", Referer: "https://cheapdatabundle.com/" },
        body: JSON.stringify({ networkKey, recipient: claim.phone, capacity }),
        signal: AbortSignal.timeout(30000),
      });
      const payload = await response.json().catch(() => null);
      const data = payload?.data ?? {};
      const accepted = response.ok && payload?.success === true;
      const providerReference = dataHubOrderReference(payload);
      if (!accepted) {
        const responseStatus = String(payload?.status ?? payload?.data?.status ?? "").trim().toLowerCase();
        const definiteRejection = response.status >= 400 && response.status < 500 || payload?.success === false || payload?.status === false ||
          ["failed", "failure", "rejected", "error"].includes(responseStatus);
        if (!definiteRejection) {
          await service.rpc("update_live_order_delivery", { p_reference: newReference, p_delivery_status: "failed" });
          const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: newReference });
          outcomes.push({ order_id: orderId, success: false, delivery_status: "failed", message: refundError
            ? "DataHub response was ambiguous. Contact support to reconcile the wallet refund."
            : "DataHub response was ambiguous. The wallet was refunded." });
          continue;
        }
        const { error: statusError } = await service.rpc("update_live_order_delivery", { p_reference: newReference, p_delivery_status: "failed",
          p_provider_transaction_id: typeof providerReference === "string" ? providerReference : null });
        if (statusError) {
          outcomes.push({ order_id: orderId, success: false, error: "DataHub rejected the retry, but its failed status could not be saved. Reconcile this order before taking another action." });
          continue;
        }
        const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: newReference });
        outcomes.push({ order_id: orderId, success: false, delivery_status: "failed",
          message: refundError ? "DataHub rejected the order; automatic wallet refund needs admin review." : "DataHub rejected the retry and the wallet debit was refunded." });
        continue;
      }
      if (typeof providerReference !== "string" || !providerReference.trim()) {
        await service.rpc("update_live_order_delivery", { p_reference: newReference, p_delivery_status: "processing" });
        outcomes.push({ order_id: orderId, success: true, delivery_status: "processing", message: "DataHub accepted the request but returned no transaction reference; reconcile it in the DataHub dashboard before any further attempt." });
        continue;
      }
      const deliveryStatus = statusOf(data.status ?? data.delivery_status ?? data.orderStatus ?? data.order_status) ?? "processing";
      const { error: statusError } = await service.rpc("update_live_order_delivery", { p_reference: newReference,
        p_delivery_status: deliveryStatus, p_provider_transaction_id: providerReference });
      if (statusError) {
        outcomes.push({ order_id: orderId, success: false, error: "DataHub responded, but the new order status could not be saved. Reconcile this order with DataHub before retrying." });
        continue;
      }
      if (deliveryStatus === "failed") {
        const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: newReference });
        outcomes.push({ order_id: orderId, success: false, delivery_status: "failed",
          message: refundError ? "Provider reported failure; automatic refund needs admin review." : "DataHub reported failure and the wallet debit was refunded." });
      } else {
        outcomes.push({ order_id: orderId, success: true, delivery_status: deliveryStatus, provider_reference: providerReference });
      }
    } catch (error) {
      await service.rpc("update_live_order_delivery", { p_reference: newReference, p_delivery_status: "failed" });
      const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: newReference });
      console.error("Admin DataHub retry ambiguous", { orderId, error: String(error) });
      outcomes.push({ order_id: orderId, success: false, delivery_status: "failed", message: refundError
        ? "The provider request timed out. Contact support to reconcile the wallet refund."
        : "The provider request timed out. The wallet was refunded." });
    }
  }
  return json(200, { success: outcomes.every((result) => result.success), results: outcomes });
});
