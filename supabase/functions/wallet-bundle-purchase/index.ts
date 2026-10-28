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
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in to buy a bundle." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const hubnetBase = Deno.env.get("HUBNET_API_BASE_URL")?.trim().replace(/\/+$/, "");
  if (!supabaseUrl || !anonKey || !serviceKey || !hubnetToken || !hubnetBase) {
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

  const networkMap: Record<string, string> = { MTN: "mtn", Telecel: "telecel", AT: "at" };
  const network = networkMap[String(order.network)];
  const size = String(order.size ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
  if (!network || !size) {
    await service.rpc("update_live_order_delivery", {
      p_reference: deliveryReference, p_delivery_status: "failed",
    });
    const { data: refund } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: deliveryReference });
    return json(200, { success: true, ...order, delivery_status: "failed", wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
      message: "The bundle could not be delivered. The wallet debit was refunded." });
  }

  const volume = String(Math.round(Number(size[1]) * (size[2].toUpperCase() === "GB" ? 1000 : 1)));
  const tokenHeader = /^Bearer\s+/i.test(hubnetToken) ? hubnetToken : `Bearer ${hubnetToken}`;
  const webhookUrl = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/hubnet-webhook`;
  try {
    const delivery = await fetch(`${hubnetBase}/live/api/context/business/transaction/${network}-new-transaction`, {
      method: "POST",
      headers: { token: tokenHeader, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: body.recipient_phone, volume, reference: deliveryReference, webhook: webhookUrl }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await delivery.json().catch(() => null);
    const envelope = result?.response ?? result;
    const resultData = envelope?.data ?? result?.data ?? {};
    const resultStatus = String(resultData?.status ?? envelope?.status ?? "").toLowerCase();
    const providerId = envelope?.transaction_id ?? resultData?.transaction_id ?? null;

    if (delivery.ok && ["true", "success", "processing", "pending"].includes(resultStatus)) {
      const delivered = ["success", "delivered", "completed"].includes(String(resultData?.status).toLowerCase());
      const deliveryStatus = delivered ? "delivered" : "processing";
      await service.rpc("update_live_order_delivery", {
        p_reference: deliveryReference, p_delivery_status: deliveryStatus, p_provider_transaction_id: providerId,
      });
      return json(200, { success: true, ...order, delivery_status: deliveryStatus,
        message: delivered ? "Data delivered successfully." : "Order accepted and is being processed." });
    }

    if (["failed", "cancelled"].includes(resultStatus)) {
      await service.rpc("update_live_order_delivery", {
        p_reference: deliveryReference, p_delivery_status: "failed", p_provider_transaction_id: providerId,
      });
      const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", {
        p_delivery_reference: deliveryReference,
      });
      return json(200, { success: true, ...order, delivery_status: "failed",
        wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
        message: refundError ? "Delivery failed. Contact support to reconcile your wallet." : "Delivery failed; your wallet was refunded." });
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
