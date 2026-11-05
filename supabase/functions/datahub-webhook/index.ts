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

async function validSignature(secret: string, rawBody: string, request: Request): Promise<boolean> {
  const signatureHeaders = ["X-Webhook-Signature", "X-Webhook-Signature-256", "X-Webhook-Hmac-SHA256",
    "X-Webhook-HMAC", "X-Hub-Signature-256", "X-Signature", "Signature"];
  const supplied = signatureHeaders.map((name) => request.headers.get(name)).find((value) => value !== null) ?? null;
  if (!supplied) return false;
  const signature = supplied.trim().replace(/^sha256=/i, "");
  const timestamp = request.headers.get("X-Webhook-Timestamp") ?? "";
  const messages = [rawBody, ...(timestamp ? [`${timestamp}.${rawBody}`, `${timestamp}${rawBody}`] : [])];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  for (const message of messages) {
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const bytes = String.fromCharCode(...digest);
    const base64 = btoa(bytes);
    const base64url = base64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (constantTimeEqual(signature.toLowerCase(), hex) || constantTimeEqual(signature, base64) ||
        constantTimeEqual(signature.replace(/=+$/, ""), base64url)) return true;
  }
  return false;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });
  const expectedToken = Deno.env.get("DATAHUB_WEBHOOK_TOKEN")?.trim();
  const suppliedToken = new URL(request.url).searchParams.get("token") ?? "";
  if (!expectedToken || expectedToken.length < 32) return reply(503, { error: "Webhook authentication is not configured." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const key = serviceKey();
  if (!supabaseUrl || !key) return reply(503, { error: "Order status service is not configured." });

  const rawBody = await request.text();
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return reply(400, { error: "Invalid JSON." }); }
  const tokenAuthorized = constantTimeEqual(suppliedToken, expectedToken);
  const signatureAuthorized = await validSignature(expectedToken, rawBody, request).catch(() => false);
  if (!tokenAuthorized && !signatureAuthorized) {
    const signatureHeaders = [...request.headers.keys()].filter((name) => /signature|webhook|hmac/i.test(name));
    console.warn("DataHub webhook authentication failed", {
      signatureHeaders, signaturePresent: signatureHeaders.some((name) => request.headers.has(name)),
      timestampPresent: request.headers.has("X-Webhook-Timestamp"),
    });
    return reply(401, { error: "Webhook authentication failed. Check the URL token or HMAC Secret Key." });
  }

  const eventType = String(event?.event ?? request.headers.get("X-Webhook-Event") ?? "").trim();
  if (["test", "webhook.test", "ping"].includes(eventType.toLowerCase()) || event?.test === true) {
    return reply(200, { received: true, test: true });
  }
  const data = event?.data;
  const supportedOrderEvents = ["order.status_updated", "order.status_changed", "order.status.changed"];
  const validOrderEvent = supportedOrderEvents.includes(eventType) &&
    data && typeof data.reference === "string" && data.reference.length <= 180 && typeof data.status === "string";
  if (!validOrderEvent) {
    console.warn("DataHub webhook rejected: invalid order event shape", {
      eventType: eventType.slice(0, 80), hasData: !!data,
      hasReference: typeof data?.reference === "string", hasStatus: typeof data?.status === "string",
    });
    return reply(400, { error: "Invalid DataHub order status event." });
  }

  // DataHub's guide guarantees the event and timestamp in the JSON payload,
  // and the HMAC in X-Webhook-Signature. It does not require separate event or
  // timestamp headers, so don't reject otherwise valid deliveries for lacking them.
  const payloadTimestamp = Date.parse(String(event.timestamp ?? ""));
  if (Number.isFinite(payloadTimestamp) && Math.abs(Date.now() - payloadTimestamp) > 10 * 60 * 1000) {
    return reply(401, { error: "Webhook timestamp is expired." });
  }

  const status = String(data.status).trim().toUpperCase().replace(/[\s-]+/g, "_");
  const deliveryStatus = ["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(status) ? "delivered"
    : ["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(status) ? "failed"
    : ["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(status) ? "processing" : null;
  if (!deliveryStatus) return reply(200, { received: true, ignored: true });

  const service = createClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: order, error } = await service.from("orders")
    .select("delivery_reference,delivery_status,provider_transaction_id,payment_status,payment_reference,recipient_phone")
    .eq("provider_transaction_id", data.reference).maybeSingle();
  if (error) return reply(500, { error: "Could not find the matching order." });
  if (!order) {
    // DataHub's documented /webhook/test sends this fixed mock order. It is
    // authenticated by HMAC above, but it will never exist in our orders table.
    const isDocumentedTestOrder = data.reference === "ORDER_123_1234567890" ||
      Number(data.orderNumber) === 290293;
    if (isDocumentedTestOrder) return reply(200, { received: true, test: true });
    return reply(503, { error: "Order reference is not linked yet; retry this webhook." });
  }

  if (["delivered", "failed"].includes(order.delivery_status)) {
    return reply(200, { received: true, duplicate: true });
  }
  if (typeof data.phoneNumber === "string" && data.phoneNumber !== order.recipient_phone) {
    console.warn("DataHub webhook rejected: recipient does not match linked order", { referenceMatched: true });
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
