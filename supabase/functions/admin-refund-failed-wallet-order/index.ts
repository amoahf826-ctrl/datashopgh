import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Use POST." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Administrator sign-in required." });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !anon || !serviceKey) return json(503, { error: "Wallet refund service is not configured." });

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
    .select("id,user_id,payment_reference,delivery_reference,payment_status,delivery_status,status,is_demo")
    .eq("id", body.order_id).maybeSingle();
  if (orderError) return json(500, { error: "Could not load the selected order." });
  if (!order || order.is_demo || order.payment_status !== "successful" ||
      order.delivery_status !== "failed" || order.status !== "failed") {
    return json(409, { error: "Only paid orders with a confirmed failed delivery can be wallet-refunded." });
  }
  if (!String(order.payment_reference ?? "").startsWith("WALLET-") || !order.user_id) {
    return json(409, { error: "This order was not paid from an account wallet; there is no wallet balance to refund." });
  }

  const { data: existingRefund, error: ledgerError } = await service.from("ledger")
    .select("id").eq("reference_type", "order").eq("reference_id", order.id).eq("kind", "refund").maybeSingle();
  if (ledgerError) return json(500, { error: "Could not verify the order's refund history." });
  if (existingRefund) return json(409, { error: "This order already has a wallet refund entry." });

  const { data: refund, error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", {
    p_delivery_reference: order.delivery_reference,
  });
  if (refundError) {
    console.error("Failed order wallet refund needs review.", { orderId: order.id, code: refundError.code });
    return json(500, { error: "Wallet refund could not be posted. Review this order and its ledger." });
  }
  if (refund?.refunded !== true) return json(409, { error: "The order was not refunded. Review its refund state before retrying." });
  return json(200, { success: true, refunded: true, order_id: order.id, wallet_balance: refund.wallet_balance });
});
