import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dataHubNetworkKey, hubnetPath, resolveBundleRoute } from "../_shared/bundle-routing.ts";
import { dataHubOrderReference } from "../_shared/datahub-order-reference.ts";
import { hubnetReference } from "../_shared/hubnet-reference.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });

function readSecret(legacy: string, collection: string): string | undefined {
  const direct = Deno.env.get(legacy)?.trim();
  if (direct) return direct;
  try {
    const values = JSON.parse(Deno.env.get(collection) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    return Object.values(values).find((value): value is string => typeof value === "string");
  } catch { return undefined; }
}

function normalizeStatus(value: unknown): "delivered" | "failed" | "processing" | null {
  const status = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(status)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(status)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(status)) return "processing";
  return null;
}

function responseAccepted(provider: "datahub" | "hubnet", payload: any): boolean {
  const envelope = provider === "hubnet" ? payload?.response ?? payload : payload;
  return provider === "hubnet"
    ? envelope?.status === true || envelope?.status === "success" || envelope?.success === true ||
      payload?.success === true || payload?.status === "success"
    : payload?.success === true;
}

function definitelyRejected(provider: "datahub" | "hubnet", payload: any): boolean {
  const envelope = provider === "hubnet" ? payload?.response ?? payload : payload;
  const status = String(envelope?.status ?? payload?.status ?? "").trim().toLowerCase();
  return envelope?.status === false || payload?.status === false || envelope?.success === false ||
    payload?.success === false || ["failed", "failure", "rejected", "error"].includes(status);
}

async function requestPaystackRefund(orderId: string, paymentReference: string, amount: number): Promise<boolean> {
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  if (!secret || !paymentReference || !Number.isSafeInteger(amount) || amount <= 0) return false;
  try {
    const response = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ transaction: paymentReference, amount, currency: "GHS",
        reference: `ORDREF-${orderId.replaceAll("-", "")}`, customer_note: "Refund for uncertain data bundle delivery",
        merchant_note: `Ambiguous provider retry for order ${orderId}` }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => null);
    return response.ok && result?.status === true;
  } catch { return false; }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in as an administrator." });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = readSecret("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readSecret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !anonKey || !serviceKey) return json(503, { error: "Order retry service is not configured." });

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData.user) return json(401, { error: "Your session expired. Sign in again." });
  const { data: isAdmin, error: roleError } = await auth.rpc("is_admin");
  if (roleError || isAdmin !== true) return json(403, { error: "Administrator access required." });

  let body: { order_ids?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const orderIds = Array.isArray(body.order_ids) ? body.order_ids : [];
  if (!orderIds.length || orderIds.length > 10 ||
      orderIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    return json(400, { error: "Provide 1 to 10 valid order IDs." });
  }
  if (new Set(orderIds).size !== orderIds.length) return json(400, { error: "Order IDs must be unique." });

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: initialOrders, error: loadError } = await service.from("orders")
    .select("id,delivery_provider,payment_reference,price,charge_amount").in("id", orderIds);
  if (loadError) return json(500, { error: "Could not load the selected orders." });
  const providers = new Set((initialOrders ?? []).map((order) => order.delivery_provider));
  const datahubKey = readSecret("DATAHUB_API_KEY", "DATAHUB_API_KEYS");
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const appBase = (Deno.env.get("APP_BASE_URL")?.trim() || "https://cheapdatabundle.com").replace(/\/+$/, "");
  let appOrigin: string;
  try {
    const base = new URL(appBase);
    if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash) throw new Error();
    appOrigin = base.origin;
  } catch { return json(503, { error: "APP_BASE_URL must be a secure site origin." }); }
  if (providers.has("datahub") && !datahubKey) return json(503, { error: "DataHub delivery is not configured." });
  if (providers.has("hubnet") && !hubnetToken) return json(503, { error: "Hubnet delivery is not configured." });
  const hubnetBase = (Deno.env.get("HUBNET_API_BASE_URL")?.trim() || "https://hubnet.app").replace(/\/+$/, "");
  if (providers.has("hubnet")) {
    try {
      const base = new URL(hubnetBase);
      if (base.protocol !== "https:" || base.hostname !== "hubnet.app" || base.username || base.password) throw new Error();
    } catch { return json(503, { error: "HUBNET_API_BASE_URL must use the verified Hubnet HTTPS origin." }); }
  }

  const outcomes: Record<string, unknown>[] = [];
  for (const orderId of orderIds as string[]) {
    const initialOrder = (initialOrders ?? []).find((order) => order.id === orderId);
    const provider = initialOrder?.delivery_provider;
    if (provider !== "datahub" && provider !== "hubnet") {
      outcomes.push({ order_id: orderId, success: false, error: "The order has no supported delivery provider." });
      continue;
    }
    const { data: claim, error: claimError } = await service.rpc("admin_claim_unknown_provider_retry", {
      p_order_id: orderId,
      p_provider: provider,
      p_actor: userData.user.id,
    });
    if (claimError || !claim) {
      outcomes.push({ order_id: orderId, success: false, error: claimError?.message ?? "Could not claim this order for retry." });
      continue;
    }

    const plan = {
      network: String(claim.network),
      category: String(claim.category ?? ""),
      subcategory: String(claim.subcategory ?? ""),
      size: String(claim.size ?? ""),
      delivery_provider: provider,
      delivery_network_type: typeof claim.delivery_network_type === "string" ? claim.delivery_network_type : null,
    };
    try {
      const route = resolveBundleRoute(plan, provider);
      const size = plan.size.trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
      if (!size) throw new Error("The saved bundle size is invalid.");
      const isGb = size[2].toUpperCase() === "GB";
      const webhook = `${url.replace(/\/+$/, "")}/functions/v1/hubnet-webhook`;
      let response: Response;
      if (provider === "datahub") {
        response = await fetch("https://user.datahubgh.com/api/external/data-purchase", {
          method: "POST",
          headers: {
            "X-API-Key": datahubKey!,
            "Content-Type": "application/json",
            Accept: "application/json",
            Origin: appOrigin,
            Referer: `${appOrigin}/`,
          },
          body: JSON.stringify({
            networkKey: dataHubNetworkKey(route.networkType),
            recipient: claim.phone,
            capacity: String(Number((Number(size[1]) * (isGb ? 1 : 0.001)).toFixed(3))),
          }),
          signal: AbortSignal.timeout(15000),
        });
      } else {
        const authHeader = /^Bearer\s+/i.test(hubnetToken!) ? hubnetToken! : `Bearer ${hubnetToken}`;
        response = await fetch(`${hubnetBase}/live/api/context/business/transaction/${hubnetPath(route.networkType)}`, {
          method: "POST",
          headers: { token: authHeader, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            phone: claim.phone,
            volume: String(Math.round(Number(size[1]) * (isGb ? 1000 : 1))),
            reference: hubnetReference(claim.reference),
            webhook,
          }),
          signal: AbortSignal.timeout(15000),
        });
      }

      const payload = await response.json().catch(() => null);
      const accepted = responseAccepted(provider, payload);
      const envelope = provider === "hubnet" ? payload?.response ?? payload : payload;
      const data = envelope?.data ?? payload?.data ?? {};
      const providerReference = provider === "datahub"
        ? dataHubOrderReference(payload)
        : data.reference ?? data.transaction_id ?? data.tracking_id ?? data.transactionReference;
      const deliveryStatus = normalizeStatus(data.status ?? data.delivery_status ?? data.orderStatus ?? data.order_status);

      if (response.ok && accepted) {
        const status = deliveryStatus ?? "processing";
        const { error: updateError } = await service.rpc("update_live_order_delivery", {
          p_reference: claim.reference,
          p_delivery_status: status,
          p_provider_transaction_id: typeof providerReference === "string"
            ? providerReference : provider === "hubnet" ? hubnetReference(claim.reference) : null,
        });
        if (updateError) {
          console.error("Could not save the retried provider order status.", { orderId, provider, code: updateError.code });
          outcomes.push({ order_id: orderId, success: false, delivery_status: "processing", error: "Provider accepted the retry, but its status could not be saved. Reconcile before another attempt." });
          continue;
        }
        if (status === "failed" && String(claim.payment_reference ?? "").startsWith("WALLET-")) {
          const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: claim.reference });
          if (refundError) {
            outcomes.push({ order_id: orderId, success: false, delivery_status: status, error: "Provider rejected delivery, but the wallet refund needs admin review." });
            continue;
          }
        }
        outcomes.push({ order_id: orderId, success: true, delivery_status: status });
        continue;
      }

      const rejected = response.status >= 400 && response.status < 500 || definitelyRejected(provider, payload);
      const status = "failed";
      const { error: updateError } = await service.rpc("update_live_order_delivery", {
        p_reference: claim.reference,
        p_delivery_status: status,
        p_provider_transaction_id: typeof providerReference === "string"
          ? providerReference : provider === "hubnet" ? hubnetReference(claim.reference) : null,
      });
      if (updateError) {
        console.error("Could not save the unresolved provider retry status.", { orderId, provider, code: updateError.code });
        outcomes.push({ order_id: orderId, success: false, delivery_status: "processing", error: "The provider response could not be saved. Reconcile before another attempt." });
        continue;
      }
      if (String(claim.payment_reference ?? initialOrder?.payment_reference ?? "").startsWith("WALLET-")) {
        const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: claim.reference });
        if (refundError) {
          outcomes.push({ order_id: orderId, success: false, delivery_status: status, error: "Provider rejected delivery, but the wallet refund needs admin review." });
          continue;
        }
      } else {
        const paymentReference = String(claim.payment_reference ?? initialOrder?.payment_reference ?? "");
        const amount = Math.round(Number(initialOrder?.charge_amount ?? initialOrder?.price) * 100);
        const refundQueued = await requestPaystackRefund(orderId, paymentReference, amount);
        if (!refundQueued) console.error("Paystack refund request could not be confirmed after an ambiguous retry.", { orderId });
      }
      console.warn("Admin provider retry returned an unresolved result.", {
        orderId,
        provider,
        httpStatus: response.status,
        responseStatus: String((payload?.response ?? payload)?.status ?? "missing"),
        accepted,
      });
      outcomes.push({ order_id: orderId, success: false, delivery_status: status,
        message: rejected ? "Provider rejected the retry." : "Provider outcome was uncertain. The order was failed and its payment refund was requested." });
    } catch (error) {
      console.error("Admin provider retry outcome could not be confirmed.", {
        orderId,
        provider,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      const { error: statusError } = await service.rpc("update_live_order_delivery", {
        p_reference: claim.reference,
        p_delivery_status: "failed",
        p_provider_transaction_id: provider === "hubnet" ? hubnetReference(claim.reference) : null,
      });
      if (statusError) console.error("Could not save the uncertain provider retry status.", { orderId, code: statusError.code });
      if (!statusError && String(claim.payment_reference ?? initialOrder?.payment_reference ?? "").startsWith("WALLET-")) {
        const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", { p_delivery_reference: claim.reference });
        if (refundError) console.error("Wallet refund needs reconciliation after an ambiguous retry.", { orderId });
      } else if (!statusError) {
        const paymentReference = String(claim.payment_reference ?? initialOrder?.payment_reference ?? "");
        const amount = Math.round(Number(initialOrder?.charge_amount ?? initialOrder?.price) * 100);
        if (!await requestPaystackRefund(orderId, paymentReference, amount)) console.error("Paystack refund needs reconciliation after an ambiguous retry.", { orderId });
      }
      outcomes.push({ order_id: orderId, success: false, delivery_status: "failed",
        message: "Provider outcome was uncertain. The order was failed and its payment refund was requested." });
    }
  }

  return json(200, { success: outcomes.every((outcome) => outcome.success), results: outcomes });
});
