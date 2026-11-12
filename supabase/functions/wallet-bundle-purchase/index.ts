import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dataHubNetworkKey, hubnetPath, resolveBundleRoute } from "../_shared/bundle-routing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

function normalizeDeliveryStatus(value: unknown): "delivered" | "failed" | "processing" | null {
  const status = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(status)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(status)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(status)) return "processing";
  return null;
}

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
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in to buy a bundle." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const datahubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const appBase = (Deno.env.get("APP_BASE_URL")?.trim() || "https://cheapdatabundle.com").replace(/\/+$/, "");
  const hubnetBase = (Deno.env.get("HUBNET_API_BASE_URL")?.trim() || "https://console.hubnet.app").replace(/\/+$/, "");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(503, { error: "Wallet bundle delivery is not fully configured on the server." });
  }

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session expired. Sign in again." });

  let body: { bundle_id?: unknown; recipient_phone?: unknown; idempotency_key?: unknown; agent_referral_code?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (typeof body.bundle_id !== "string" || body.bundle_id.length > 100 ||
      typeof body.recipient_phone !== "string" || !/^0\d{9}$/.test(body.recipient_phone) ||
      typeof body.idempotency_key !== "string" || !/^[0-9a-f-]{36}$/i.test(body.idempotency_key) ||
      (body.agent_referral_code != null && (typeof body.agent_referral_code !== "string" || body.agent_referral_code.length > 80))) {
    return json(400, { error: "Choose a bundle and enter a valid 10 digit Ghanaian phone number." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: providerSetting, error: providerSettingError } = await service.from("platform_settings")
    .select("value").eq("key", "active_bundle_provider").maybeSingle();
  if (providerSettingError) return json(503, { error: "Could not read the active bundle provider." });
  const fallbackProvider = providerSetting?.value?.provider === "hubnet" ? "hubnet" : "datahub";
  const enabledProviders = { datahub: providerSetting?.value?.enabled?.datahub !== false, hubnet: providerSetting?.value?.enabled?.hubnet !== false };
  const { data: configuredPlan } = await service.from("bundles").select("network,category,subcategory,delivery_provider,delivery_network_type,size").eq("id", body.bundle_id).eq("is_active", true).maybeSingle();
  if (!configuredPlan) return json(400, { error: "This data plan is unavailable." });
  const route = resolveBundleRoute(configuredPlan, fallbackProvider);
  const activeProvider = route.provider;
  if (!enabledProviders[activeProvider]) return json(503, { error: `${activeProvider === "hubnet" ? "Hubnet" : "DataHub GH"} is disabled for this plan.` });
  if (activeProvider === "datahub" && !datahubKey) return json(503, { error: "DataHub wallet delivery is not configured on the server." });
  if (activeProvider === "hubnet" && !hubnetToken) return json(503, { error: "Hubnet wallet delivery is not configured on the server." });
  let networkKey: string;
  try { networkKey = activeProvider === "datahub" ? dataHubNetworkKey(route.networkType) : hubnetPath(route.networkType); }
  catch (error) { return json(503, { error: error instanceof Error ? error.message : "Invalid provider network mapping." }); }
  if (activeProvider === "hubnet") {
    try { const base = new URL(hubnetBase); if (base.protocol !== "https:" || base.hostname !== "console.hubnet.app" || base.username || base.password) throw new Error(); }
    catch { return json(503, { error: "HUBNET_API_BASE_URL must use the verified Hubnet HTTPS origin." }); }
  }
  let appOrigin: string;
  try {
    const base = new URL(appBase);
    if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash) throw new Error();
    appOrigin = base.origin;
  } catch { return json(503, { error: "APP_BASE_URL must be a secure site origin." }); }
  const { data: sales, error: settingError } = await service.from("platform_settings")
    .select("value").eq("key", "storefront_live_sales").maybeSingle();
  if (settingError || sales?.value?.enabled !== true) return json(503, { error: "Live bundle sales are currently unavailable." });

  const paymentReference = `WALLET-${crypto.randomUUID().replaceAll("-", "")}`;
  const deliveryReference = `DS${crypto.randomUUID().replaceAll("-", "").slice(0, 23)}`;
  const { data: order, error: orderError } = await service.rpc("create_wallet_bundle_order", {
    p_user_id: authData.user.id,
    p_bundle_id: body.bundle_id,
    p_recipient_phone: body.recipient_phone,
    p_idempotency_key: body.idempotency_key,
    p_payment_reference: paymentReference,
    p_delivery_reference: deliveryReference,
    p_agent_referral_code: typeof body.agent_referral_code === "string" ? body.agent_referral_code : null,
  });
  if (orderError || !order) {
    const message = orderError?.message ?? "Could not place this wallet order.";
    const status = /insufficient wallet balance/i.test(message) ? 409 : 400;
    return json(status, { error: message });
  }
  if (!order.created) return json(200, { success: true, ...order, duplicate: true });
  await service.from("orders").update({ delivery_provider: activeProvider }).eq("id", order.order_id);

  const size = String(order.size ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
  if (!size) {
    await service.rpc("update_live_order_delivery", {
      p_reference: deliveryReference, p_delivery_status: "failed",
    });
    const { data: refund } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: deliveryReference });
    return json(200, { success: true, ...order, delivery_status: "failed", wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
      message: "The bundle could not be delivered. The wallet debit was refunded." });
  }

  const capacity = String(Number((Number(size[1]) * (size[2].toUpperCase() === "GB" ? 1 : 0.001)).toFixed(3)));
  const webhook = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/hubnet-webhook`;
  try {
    let delivery: Response;
    if (activeProvider === "datahub") {
      delivery = await fetch("https://user.datahubgh.com/api/external/data-purchase", {
        method: "POST",
        // DataHub API keys are registered against the storefront Website URL.
        // Include that origin on this server-side request so the provider can
        // associate the purchase with the registered site.
        headers: {
          "X-API-Key": datahubKey!,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: appOrigin,
          Referer: `${appOrigin}/`,
        },
        body: JSON.stringify({ networkKey, recipient: body.recipient_phone, capacity }),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      const volume = String(Math.round(Number(size[1]) * (size[2].toUpperCase() === "GB" ? 1000 : 1)));
      const authHeader = /^Bearer\s+/i.test(hubnetToken!) ? hubnetToken! : `Bearer ${hubnetToken}`;
      delivery = await fetch(`${hubnetBase}/live/api/context/business/transaction/${networkKey}`, {
        method: "POST",
        headers: { token: authHeader, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ phone: body.recipient_phone, volume, reference: deliveryReference, webhook }),
        signal: AbortSignal.timeout(15000),
      });
    }
    const result = await delivery.json().catch(() => null);
    const envelope = activeProvider === "hubnet" ? (result?.response ?? result) : result;
    const resultData = envelope?.data ?? result?.data ?? {};
    const accepted = activeProvider === "hubnet"
      ? (envelope?.status === true || envelope?.status === "success" || result?.success === true || result?.status === "success")
      : result?.success === true;
    const providerStatus = normalizeDeliveryStatus(resultData.status ?? resultData.delivery_status ?? resultData.orderStatus ?? resultData.order_status);
    if (delivery.ok && accepted && (activeProvider === "hubnet" || typeof resultData.reference === "string")) {
      if (providerStatus === "failed") {
        await service.rpc("update_live_order_delivery", { p_reference: deliveryReference, p_delivery_status: "failed",
          p_provider_transaction_id: resultData.reference ?? resultData.transaction_id ?? resultData.tracking_id ?? deliveryReference });
        const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: deliveryReference });
        const providerReason = String(resultData.message ?? result?.message ?? result?.error ?? "").replace(/[<>\r\n]+/g, " ").trim().slice(0, 180);
        return json(200, { success: true, ...order, delivery_status: "failed", wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
          message: refundError ? "The provider reported a failed delivery. Contact support to reconcile your wallet." : `The ${activeProvider === "hubnet" ? "Hubnet" : "DataHub GH"} provider reported a failed delivery${providerReason ? `: ${providerReason}` : ""}. Your wallet has been refunded.` });
      }
      const deliveryStatus = providerStatus ?? "unknown";
      await service.rpc("update_live_order_delivery", {
        p_reference: deliveryReference, p_delivery_status: deliveryStatus,
        p_provider_transaction_id: resultData.reference ?? resultData.transaction_id ?? resultData.tracking_id ?? deliveryReference,
      });
      return json(200, { success: true, ...order, delivery_status: deliveryStatus,
        message: deliveryStatus === "delivered" ? "Data delivered successfully."
          : deliveryStatus === "processing" ? "The active provider accepted the order and is processing it."
          : "The active provider accepted the order. Its final status is not available yet; check order history shortly." });
    }

    if (delivery.status >= 400 && delivery.status < 500) {
      await service.rpc("update_live_order_delivery", {
        p_reference: deliveryReference, p_delivery_status: "failed",
      });
      const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", {
        p_delivery_reference: deliveryReference,
      });
      return json(200, { success: true, ...order, delivery_status: "failed",
        wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
        message: refundError ? "The provider rejected delivery. Contact support to reconcile your wallet." : `${activeProvider === "hubnet" ? "Hubnet" : "DataHub GH"} rejected the delivery request${String(result?.message ?? result?.error ?? "").replace(/[<>\r\n]+/g, " ").trim() ? `: ${String(result?.message ?? result?.error).replace(/[<>\r\n]+/g, " ").trim().slice(0, 180)}` : ""}. Your wallet has been refunded.` });
    }

    await service.rpc("update_live_order_delivery", { p_reference: deliveryReference, p_delivery_status: "unknown" });
    return json(200, { success: true, ...order, delivery_status: "unknown",
      message: "Order status is being checked. Please do not submit it again." });
  } catch {
    // The provider may have accepted the request before a network timeout. Never auto-refund an uncertain delivery.
    await service.rpc("update_live_order_delivery", { p_reference: deliveryReference, p_delivery_status: "unknown" });
    return json(200, { success: true, ...order, delivery_status: "unknown",
      message: "Order status is being checked. Please do not submit it again." });
  }
});
