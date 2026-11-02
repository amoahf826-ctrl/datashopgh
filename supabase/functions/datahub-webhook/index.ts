import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function serviceKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;
  try {
    const values = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
    return typeof values.default === "string" ? values.default : Object.values(values).find((v): v is string => typeof v === "string");
  } catch { return undefined; }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });
  const expectedToken = Deno.env.get("DATAHUB_WEBHOOK_TOKEN")?.trim();
  const suppliedToken = new URL(request.url).searchParams.get("token") ?? "";
  if (!expectedToken || expectedToken.length < 32 || !constantTimeEqual(suppliedToken, expectedToken)) {
    return reply(401, { error: "Invalid webhook token." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const key = serviceKey();
  if (!supabaseUrl || !key) return reply(503, { error: "Order status service is not configured." });

  let event: any;
  try { event = await request.json(); } catch { return reply(400, { error: "Invalid JSON." }); }
  const data = event?.data;
  if (event?.event !== "order.status_updated" || !data || typeof data.reference !== "string" ||
      data.reference.length > 180 || typeof data.status !== "string") {
    return reply(400, { error: "Invalid DataHub order status event." });
  }

  const timestampHeader = request.headers.get("X-Webhook-Timestamp");
  const timestamp = Date.parse(String(event.timestamp ?? ""));
  if (!timestampHeader || timestampHeader !== event.timestamp || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
    return reply(401, { error: "Webhook timestamp is missing, mismatched, or expired." });
  }
  if (request.headers.get("X-Webhook-Event") !== "order.status_updated" ||
      request.headers.get("User-Agent") !== "DatahubGHMainServer-Webhook/1.0") {
    return reply(401, { error: "Unexpected DataHub webhook headers." });
  }

  const status = String(data.status).toUpperCase();
  const deliveryStatus = status === "SUCCESSFUL" ? "delivered"
    : status === "FAILED" ? "failed"
    : ["PENDING", "PROCESSING"].includes(status) ? "processing" : null;
  if (!deliveryStatus) return reply(200, { received: true, ignored: true });

  const service = createClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: order, error } = await service.from("orders")
    .select("delivery_reference,delivery_status,provider_transaction_id,payment_status,payment_reference,recipient_phone")
    .eq("provider_transaction_id", data.reference).maybeSingle();
  if (error) return reply(500, { error: "Could not find the matching order." });
  if (!order) return reply(503, { error: "Order reference is not linked yet; retry this webhook." });

  if (["delivered", "failed"].includes(order.delivery_status)) {
    return reply(200, { received: true, duplicate: true });
  }
  if (typeof data.phoneNumber === "string" && data.phoneNumber !== order.recipient_phone) {
    return reply(400, { error: "Webhook recipient does not match the order." });
  }

  const { error: updateError } = await service.rpc("update_live_order_delivery", {
    p_reference: order.delivery_reference,
    p_delivery_status: deliveryStatus,
    p_provider_transaction_id: data.reference,
  });
  if (updateError) return reply(500, { error: "Could not save the provider status." });

  if (deliveryStatus === "failed" && String(order.payment_reference ?? "").startsWith("WALLET-")) {
    const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", {
      p_delivery_reference: order.delivery_reference,
    });
    if (refundError) return reply(500, { error: "Failure saved but the wallet refund needs reconciliation." });
  }

  return reply(200, { received: true, updated: true });
});
