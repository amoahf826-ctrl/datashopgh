import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dataHubNetworkKey, hubnetPath, resolveBundleRoute } from "../_shared/bundle-routing.ts";
import { hubnetReference } from "../_shared/hubnet-reference.ts";
import { dataHubOrderReference } from "../_shared/datahub-order-reference.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function hubnetResponseStatus(payload: any): "delivered" | "failed" | "processing" | null {
  const envelope = payload?.response ?? payload;
  const data = envelope?.data ?? payload?.data ?? {};
  return normalizeDeliveryStatus(
    data.delivery_status ?? data.order_status ?? data.orderStatus ?? data.status ??
    envelope?.delivery_status ?? envelope?.order_status ?? envelope?.orderStatus,
  );
}

function hubnetExplicitlyRejected(payload: any): boolean {
  const envelope = payload?.response ?? payload;
  const status = String(envelope?.status ?? payload?.status ?? "").trim().toLowerCase();
  return envelope?.status === false || payload?.status === false || envelope?.success === false || payload?.success === false ||
    ["failed", "failure", "rejected", "error"].includes(status);
}

function dataHubExplicitlyRejected(payload: any): boolean {
  const envelope = payload?.response ?? payload;
  const status = String(envelope?.status ?? payload?.status ?? "").trim().toLowerCase();
  return envelope?.success === false || payload?.success === false || envelope?.status === false || payload?.status === false ||
    ["failed", "failure", "rejected", "error"].includes(status);
}

async function getHubnetOrderStatus(base: string, token: string, reference: string) {
  const url = new URL(`${base}/live/api/context/business/transaction/check-transaction-status`);
  url.searchParams.set("reference", reference);
  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  const response = await fetch(url, {
    headers: { token: authHeader, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  const envelope = payload?.response ?? payload;
  const accepted = envelope?.status === true || envelope?.status === "success" ||
    payload?.status === true || payload?.status === "success";
  return response.ok && accepted ? hubnetResponseStatus(payload) : null;
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
  if (request.method !== "POST" && request.method !== "GET") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  const suppliedApiKey = request.headers.get("x-agent-api-key")?.trim() ?? "";

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const datahubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const appBase = (Deno.env.get("APP_BASE_URL")?.trim() || "https://cheapdatabundle.com").replace(/\/+$/, "");
  const hubnetBase = (Deno.env.get("HUBNET_API_BASE_URL")?.trim() || "https://hubnet.app").replace(/\/+$/, "");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(503, { error: "Wallet bundle delivery is not fully configured on the server." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let accountUserId: string;
  let isPartnerApiRequest = false;
  if (suppliedApiKey) {
    if (!/^cdb_live_[0-9a-f]{64}$/i.test(suppliedApiKey)) return json(401, { error: "Invalid provider API key." });
    const keyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(suppliedApiKey)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const { data: keyRow, error: keyError } = await service.from("agent_partner_api_keys").select("id,agent_id").eq("key_hash", keyHash).is("revoked_at", null).maybeSingle();
    if (keyError || !keyRow) return json(401, { error: "Invalid or revoked provider API key." });
    const { data: account, error: accountError } = await service.from("agent_accounts").select("user_id,is_active,deleted_at").eq("user_id", keyRow.agent_id).maybeSingle();
    if (accountError || !account?.is_active || account.deleted_at) return json(403, { error: "This provider account is inactive." });
    accountUserId = keyRow.agent_id;
    isPartnerApiRequest = true;
    await service.from("agent_partner_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id);
  } else {
    if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in or provide an agent provider API key." });
    const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: authData, error: authError } = await auth.auth.getUser();
    if (authError || !authData.user) return json(401, { error: "Your session expired. Sign in again." });
    accountUserId = authData.user.id;
  }

  if (request.method === "GET") {
    if (!isPartnerApiRequest) return json(405, { error: "GET endpoints require an agent provider API key." });
    const params = new URL(request.url).searchParams;
    if (params.get("action") === "plans") {
      const { data: bundles, error: bundlesError } = await service.from("bundles").select("id,network,category,subcategory,size,validity,price,delivery_provider,delivery_network_type").eq("is_active", true).eq("is_demo", false).order("network").order("price");
      if (bundlesError) return json(500, { error: "Could not load available plans." });
      const { data: activeNetworks, error: networksError } = await service.from("networks").select("id").eq("is_active", true);
      if (networksError) return json(500, { error: "Could not load available networks." });
      const allowedNetworks = new Set((activeNetworks ?? []).map((network) => network.id));
      const { data: account } = await service.from("agent_accounts").select("agent_type").eq("user_id", accountUserId).maybeSingle();
      const [{ data: overridesData }, { data: storePrices }, { data: adminPrices }] = await Promise.all([
        service.from("super_agent_bundle_prices").select("bundle_id,override_price").eq("super_agent_id", accountUserId),
        service.from("agent_storefront_bundle_prices").select("bundle_id,customer_price").eq("agent_id", accountUserId),
        service.from("agent_customer_bundle_prices").select("bundle_id,customer_price").eq("agent_id", accountUserId),
      ]);
      const overrides: Record<string, number> = {};
      if (account?.agent_type === "super_agent") {
        Object.assign(overrides, Object.fromEntries((overridesData ?? []).map((row) => [row.bundle_id, Number(row.override_price)])));
      }
      const ownStore = Object.fromEntries((storePrices ?? []).map((row) => [row.bundle_id, Number(row.customer_price)]));
      const adminStore = Object.fromEntries((adminPrices ?? []).map((row) => [row.bundle_id, Number(row.customer_price)]));
      return json(200, { success: true, currency: "GHS", plans: (bundles ?? []).filter((plan) => allowedNetworks.has(plan.network)).map((plan) => ({ id: plan.id, network: plan.network, category: plan.category, subcategory: plan.subcategory, size: plan.size, validity: plan.validity, price: ownStore[plan.id] ?? adminStore[plan.id] ?? Number(plan.price), wallet_cost: overrides[plan.id] ?? Number(plan.price) })) });
    }
    if (params.get("action") === "status") {
      const reference = params.get("reference")?.trim() ?? "";
      if (!reference || reference.length > 100) return json(400, { error: "Provide a valid order reference." });
      const orderFields = "id,bundle_id,recipient_phone,price,fee_amount,charge_amount,status,payment_status,delivery_status,delivery_provider,payment_reference,delivery_reference,provider_transaction_id,checkout_url,created_at,delivery_updated_at,bundles(network,size,category,subcategory)";
      const orders = service.from("orders").select(orderFields).eq("user_id", accountUserId);
      let order: any = null;
      let error: any = null;
      if (/^[0-9a-f-]{36}$/i.test(reference)) {
        ({ data: order, error } = await orders.eq("id", reference).maybeSingle());
        if (error) return json(500, { error: "Could not check this order." });
      }
      if (!order) {
        ({ data: order, error } = await service.from("orders").select(orderFields).eq("user_id", accountUserId).eq("delivery_reference", reference).maybeSingle());
        if (error) return json(500, { error: "Could not check this order." });
      }
      if (!order) {
        ({ data: order, error } = await service.from("orders").select(orderFields).eq("user_id", accountUserId).eq("provider_transaction_id", reference).maybeSingle());
        if (error) return json(500, { error: "Could not check this order." });
      }
      if (!order) return json(404, { error: "Order not found for this provider account." });
      return json(200, { success: true, order });
    }
    return json(400, { error: "Use action=plans or action=status&reference=…" });
  }

  let body: { bundle_id?: unknown; recipient_phone?: unknown; idempotency_key?: unknown; agent_referral_code?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (typeof body.bundle_id !== "string" || body.bundle_id.length > 100 ||
      typeof body.recipient_phone !== "string" || !/^0\d{9}$/.test(body.recipient_phone) ||
      typeof body.idempotency_key !== "string" || !/^[0-9a-f-]{36}$/i.test(body.idempotency_key) ||
      (body.agent_referral_code != null && (typeof body.agent_referral_code !== "string" || body.agent_referral_code.length > 80))) {
    return json(400, { error: "Choose a bundle and enter a valid 10 digit Ghanaian phone number." });
  }

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
    try { const base = new URL(hubnetBase); if (base.protocol !== "https:" || base.hostname !== "hubnet.app" || base.username || base.password) throw new Error(); }
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
    p_user_id: accountUserId,
    p_bundle_id: body.bundle_id,
    p_recipient_phone: body.recipient_phone,
    p_idempotency_key: body.idempotency_key,
    p_payment_reference: paymentReference,
    p_delivery_reference: deliveryReference,
    p_agent_referral_code: !isPartnerApiRequest && typeof body.agent_referral_code === "string" ? body.agent_referral_code : null,
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
  const providerReference = hubnetReference(deliveryReference);
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
        body: JSON.stringify({ phone: body.recipient_phone, volume, reference: providerReference, webhook }),
        signal: AbortSignal.timeout(15000),
      });
    }
    const result = await delivery.json().catch(() => null);
    const envelope = activeProvider === "hubnet" ? (result?.response ?? result) : result;
    const resultData = envelope?.data ?? result?.data ?? {};
    const providerReference = activeProvider === "datahub"
      ? dataHubOrderReference(result)
      : resultData.reference ?? resultData.transaction_id ?? resultData.tracking_id ?? resultData.transactionReference;
    const accepted = activeProvider === "hubnet"
      ? (envelope?.status === true || envelope?.status === "success" || result?.success === true || result?.status === "success")
      : result?.success === true;
    const providerStatus = normalizeDeliveryStatus(resultData.status ?? resultData.delivery_status ?? resultData.orderStatus ?? resultData.order_status);
    if (activeProvider === "datahub" && !accepted && dataHubExplicitlyRejected(result)) {
      const reason = String(envelope?.message ?? result?.message ?? result?.error ?? resultData?.message ?? "")
        .replace(/[<>\r\n]+/g, " ").trim().slice(0, 180);
      console.error("DataHub rejected wallet delivery", { reference: deliveryReference, networkType, httpStatus: delivery.status, reason });
      await service.rpc("update_live_order_delivery", {
        p_reference: deliveryReference,
        p_delivery_status: "failed",
        p_provider_transaction_id: typeof providerReference === "string" ? providerReference : null,
      });
      const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: deliveryReference });
      return json(200, { success: true, ...order, delivery_status: "failed", wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
        message: refundError ? "DataHub rejected the order. Contact support to reconcile your wallet." : `DataHub rejected the order${reason ? `: ${reason}` : ""}. Your wallet has been refunded.` });
    }
    if (activeProvider === "hubnet" && delivery.ok && !accepted && hubnetExplicitlyRejected(result)) {
      const reason = String(envelope?.message ?? result?.message ?? result?.error ?? resultData?.message ?? "")
        .replace(/[<>\r\n]+/g, " ").trim().slice(0, 180);
      console.error("Hubnet rejected wallet delivery", { reference: deliveryReference, networkType, httpStatus: delivery.status, reason });
      await service.rpc("update_live_order_delivery", {
        p_reference: deliveryReference,
        p_delivery_status: "failed",
        p_provider_transaction_id: typeof providerReference === "string" ? providerReference : null,
      });
      const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: deliveryReference });
      return json(200, { success: true, ...order, delivery_status: "failed", wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
        message: refundError ? "The order was rejected. Contact support to reconcile your wallet." : `The order was rejected${reason ? `: ${reason}` : ""}. Your wallet has been refunded.` });
    }
    if (delivery.ok && accepted && (activeProvider === "hubnet" || typeof providerReference === "string")) {
      if (providerStatus === "failed") {
        // Hubnet's purchase response can report a transient/ambiguous status.
        // Confirm it against the transaction-status endpoint before refunding;
        // otherwise an order that Hubnet later delivers could be refunded.
        let confirmedStatus: "delivered" | "failed" | "processing" | null = providerStatus;
        if (activeProvider === "hubnet") {
          try { confirmedStatus = await getHubnetOrderStatus(hubnetBase, hubnetToken!, providerReference); }
          catch { confirmedStatus = null; }
          if (!confirmedStatus) {
            await service.rpc("update_live_order_delivery", { p_reference: deliveryReference, p_delivery_status: "unknown",
              p_provider_transaction_id: typeof providerReference === "string" ? providerReference : null });
            return json(200, { success: true, ...order, delivery_status: "unknown",
              message: "Hubnet accepted the order, but its final status is not confirmed yet. Please check order history shortly." });
          }
          if (confirmedStatus !== "failed") {
            await service.rpc("update_live_order_delivery", { p_reference: deliveryReference, p_delivery_status: confirmedStatus,
              p_provider_transaction_id: typeof providerReference === "string" ? providerReference : null });
            return json(200, { success: true, ...order, delivery_status: confirmedStatus,
              message: confirmedStatus === "delivered" ? "Data delivered successfully." : "Hubnet is processing the order." });
          }
        }
        await service.rpc("update_live_order_delivery", { p_reference: deliveryReference, p_delivery_status: "failed",
          p_provider_transaction_id: typeof providerReference === "string" ? providerReference : null });
        const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: deliveryReference });
        const providerReason = String(resultData.message ?? result?.message ?? result?.error ?? "").replace(/[<>\r\n]+/g, " ").trim().slice(0, 180);
        return json(200, { success: true, ...order, delivery_status: "failed", wallet_balance: refund?.wallet_balance ?? order.wallet_balance,
          message: refundError ? "The provider reported a failed delivery. Contact support to reconcile your wallet." : `Delivery failed${providerReason ? `: ${providerReason}` : ""}. Your wallet has been refunded.` });
      }
      const deliveryStatus = providerStatus ?? "unknown";
      await service.rpc("update_live_order_delivery", {
        p_reference: deliveryReference, p_delivery_status: deliveryStatus,
        p_provider_transaction_id: typeof providerReference === "string" ? providerReference : null,
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
        message: refundError ? "The provider rejected delivery. Contact support to reconcile your wallet." : `Delivery was rejected${String(result?.message ?? result?.error ?? "").replace(/[<>\r\n]+/g, " ").trim() ? `: ${String(result?.message ?? result?.error).replace(/[<>\r\n]+/g, " ").trim().slice(0, 180)}` : ""}. Your wallet has been refunded.` });
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
