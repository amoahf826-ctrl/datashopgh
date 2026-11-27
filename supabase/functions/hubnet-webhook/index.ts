import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hubnetReference, isHubnetDeliveryReference, isInternalDeliveryReference } from "../_shared/hubnet-reference.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mapDeliveryStatus(value: unknown): "delivered" | "failed" | "processing" | null {
  const state = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(state)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(state)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(state)) return "processing";
  return null;
}

function extractDeliveryStatus(payload: any) {
  const queue = [{ value: payload, allowStatus: false }];
  const seen = new Set<object>();
  while (queue.length) {
    const { value, allowStatus } = queue.shift()!;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const key of ["delivery_status", "deliveryStatus", "order_status", "orderStatus"]) {
      const status = mapDeliveryStatus(value[key]);
      if (status) return status;
    }
    if (allowStatus) {
      const status = mapDeliveryStatus(value.status);
      if (status) return status;
    }
    for (const key of ["response", "data", "transaction", "order", "result", "details"]) {
      if (value[key] && typeof value[key] === "object") queue.push({ value: value[key], allowStatus: key !== "response" });
    }
  }
  return null;
}

function readServiceKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;
  try {
    const values = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = readServiceKey();
  const token = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const base = Deno.env.get("HUBNET_API_BASE_URL")?.trim().replace(/\/+$/, "");
  if (!supabaseUrl || !serviceKey || !token || !base) return json(503, { error: "Delivery status service is not configured." });

  let body: any;
  try { body = await request.json(); } catch { return json(400, { error: "Invalid JSON." }); }
  const reference = body?.reference ?? body?.data?.reference ?? body?.transaction?.reference ?? body?.data?.transaction?.reference;
  if (typeof reference !== "string" || (!isInternalDeliveryReference(reference) && !isHubnetDeliveryReference(reference))) return json(400, { error: "Valid order reference is required." });

  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  try {
    const referencesToCheck = isHubnetDeliveryReference(reference) ? [reference] : [hubnetReference(reference), reference];
    let checked: Response | null = null;
    let result: any = null;
    for (const candidate of referencesToCheck) {
      const checkUrl = new URL(`${base}/live/api/context/business/transaction/check-transaction-status`);
      checkUrl.searchParams.set("reference", candidate);
      checked = await fetch(checkUrl, {
        headers: { token: authHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      result = await checked.json().catch(() => null);
      const candidateEnvelope = result?.response ?? result;
      if (checked.ok && (candidateEnvelope?.status === true || candidateEnvelope?.status === "success" || result?.status === true || result?.status === "success")) break;
    }
    if (!checked) return json(200, { received: true, verified: false });
    const envelope = result?.response ?? result;
    if (!checked.ok || !(envelope?.status === true || envelope?.status === "success" || result?.status === true || result?.status === "success")) return json(200, { received: true, verified: false });
    const deliveryStatus = extractDeliveryStatus(result);
    if (!deliveryStatus) return json(200, { received: true, verified: false });

    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    let internalReference = reference;
    if (isHubnetDeliveryReference(reference)) {
      const { data: matches, error: lookupError } = await service.from("orders")
        .select("delivery_reference").like("delivery_reference", `${reference}%`).limit(2);
      if (lookupError || matches?.length !== 1 || !matches[0]?.delivery_reference) return json(200, { received: true, verified: false });
      internalReference = matches[0].delivery_reference;
    }
    const { error } = await service.rpc("update_live_order_delivery", {
      p_reference: internalReference,
      p_delivery_status: deliveryStatus,
      p_provider_transaction_id: envelope?.transaction_id ?? envelope?.data?.transaction_id ?? hubnetReference(internalReference),
    });
    if (error) return json(500, { error: "Verified status could not be saved." });
    if (deliveryStatus === "failed") {
      const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", {
        p_delivery_reference: internalReference,
      });
      if (refundError) return json(500, { error: "Verified delivery failure was saved, but wallet refund needs reconciliation." });
    }
    return json(200, { received: true, verified: true });
  } catch {
    return json(500, { error: "Could not verify provider status." });
  }
});
