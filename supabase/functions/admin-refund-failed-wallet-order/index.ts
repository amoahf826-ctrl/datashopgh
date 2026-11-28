import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Use POST." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Administrator sign-in required." });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = readSecret("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readSecret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !anon || !serviceKey) return json(503, { error: "Order refund service is not configured." });

  const auth = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session expired. Sign in again." });
  const { data: isAdmin, error: adminError } = await auth.rpc("is_admin");
  if (adminError || isAdmin !== true) return json(403, { error: "Administrator access required." });

  let body: { order_id?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Invalid JSON request." }); }
  if (typeof body.order_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.order_id)) {
    return json(400, { error: "Provide a valid order ID." });
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: order, error: orderError } = await service.from("orders")
    .select("id,user_id,payment_reference,delivery_reference,payment_status,delivery_status,status,is_demo,price,charge_amount")
    .eq("id", body.order_id).maybeSingle();
  if (orderError) return json(500, { error: "Could not load the selected order." });
  if (!order || order.is_demo || order.payment_status !== "successful" ||
      !["failed", "unknown"].includes(String(order.delivery_status)) || !["failed", "processing"].includes(String(order.status))) {
    return json(409, { error: "Only paid failed or unresolved orders can be refunded after administrator review." });
  }
  const paymentReference = String(order.payment_reference ?? "");
  const method = paymentReference.startsWith("WALLET-") ? "wallet" : "paystack";
  if (method === "wallet" && !order.user_id) return json(409, { error: "The wallet-funded order has no wallet owner." });
  const { data: existingRefund, error: historyError } = await service.from("order_refunds")
    .select("id,status,method,provider_reference").eq("order_id", order.id).maybeSingle();
  if (historyError) return json(503, { error: "Apply migration 202611280001_admin_issued_order_refunds.sql before issuing refunds." });
  if (existingRefund) return json(409, { error: `A ${existingRefund.status} refund record already exists for this order. Review it before taking another action.` });

  const amount = method === "paystack" ? Number(order.charge_amount ?? order.price) : Number(order.price);
  if (!Number.isFinite(amount) || amount <= 0) return json(409, { error: "The refundable order amount is invalid." });
  const refundReference = method === "paystack" ? `ORDREF-${String(order.id).replaceAll("-", "")}` : null;
  const { data: reservation, error: reserveError } = await service.from("order_refunds").insert({
    order_id: order.id, method, status: "processing", amount, provider_reference: refundReference, issued_by: authData.user.id,
    provider_message: "Refund explicitly initiated by an administrator.",
  }).select("id").single();
  if (reserveError || !reservation) return json(409, { error: "A refund has already been started or its status needs review." });

  if (method === "wallet") {
    const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", {
      p_delivery_reference: order.delivery_reference,
    });
    if (refundError || refund?.refunded !== true) {
      await service.from("order_refunds").update({ status: "failed", provider_message: "Admin wallet refund failed; review the wallet ledger." }).eq("id", reservation.id);
      console.error("Admin wallet refund failed.", { orderId: order.id, code: refundError?.code });
      return json(500, { error: "Wallet refund could not be posted. Review the order and wallet ledger." });
    }
    await service.from("order_refunds").update({ status: "completed", provider_message: "Wallet credit posted by administrator." }).eq("id", reservation.id);
    return json(200, { success: true, refunded: true, method, order_id: order.id, wallet_balance: refund.wallet_balance });
  }

  const paystackSecret = readSecret("PAYSTACK_SECRET_KEY", "PAYSTACK_SECRET_KEYS");
  if (!paystackSecret || !paymentReference) {
    await service.from("order_refunds").update({ status: "failed", provider_message: "Paystack refund secret or payment reference is not configured." }).eq("id", reservation.id);
    return json(503, { error: "Paystack refund is not configured on the server." });
  }
  try {
    const response = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ transaction: paymentReference, amount: Math.round(amount * 100), currency: "GHS", reference: refundReference,
        customer_note: "Refund issued by CheapDataBundle administrator.", merchant_note: `Admin-issued refund for order ${order.id}` }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.status !== true) {
      await service.from("order_refunds").update({ status: "failed", provider_message: String(result?.message ?? "Paystack did not accept the refund request.").slice(0, 300) }).eq("id", reservation.id);
      return json(502, { error: "Paystack did not accept the refund request. Review the payment in Paystack before trying again." });
    }
    const paystackStatus = String(result?.data?.status ?? "pending").toLowerCase();
    const completed = ["processed", "success", "successful", "completed"].includes(paystackStatus);
    await service.from("order_refunds").update({ status: completed ? "completed" : "processing",
      provider_message: `Paystack accepted the administrator refund request (${paystackStatus || "pending"}).` }).eq("id", reservation.id);
    await service.from("audit_log").insert({ actor_id: authData.user.id, action: "admin_order_refund_issued", entity: "order", entity_id: order.id,
      details: { method, amount, paystack_reference: refundReference, paystack_status: paystackStatus || "pending" } });
    return json(200, { success: true, refunded: completed, refund_status: completed ? "completed" : "processing", method, order_id: order.id, reference: refundReference });
  } catch {
    // The external outcome may be uncertain. Keep the unique reservation so a second click cannot double-refund.
    await service.from("order_refunds").update({ status: "processing", provider_message: "Paystack refund outcome is unconfirmed; reconcile in Paystack before retrying." }).eq("id", reservation.id);
    return json(202, { success: true, refunded: false, refund_status: "processing", method, order_id: order.id, reference: refundReference,
      message: "Paystack refund outcome is being reconciled. Do not submit another refund request." });
  }
});
