import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

function matchesCronSecret(supplied: string, expected: string | undefined): boolean {
  if (!expected || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

type DeliveryStatus = "delivered" | "failed" | "processing";
function normalizeStatus(value: unknown): DeliveryStatus | null {
  const status = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(status)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(status)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(status)) return "processing";
  return null;
}

function extractStatus(payload: any): DeliveryStatus | null {
  const queue = [{ value: payload, allowStatus: false }];
  const seen = new Set<object>();
  while (queue.length) {
    const item = queue.shift()!;
    const current = item.value;
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of ["delivery_status", "deliveryStatus", "order_status", "orderStatus"]) {
      const status = normalizeStatus(current[key]);
      if (status) return status;
    }
    if (item.allowStatus) {
      const status = normalizeStatus(current.status);
      if (status) return status;
    }
    for (const key of ["response", "data", "transaction", "order", "result", "details"]) {
      if (current[key] && typeof current[key] === "object") queue.push({ value: current[key], allowStatus: key !== "response" });
    }
  }
  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  const cronAuthorized = matchesCronSecret(request.headers.get("x-provider-status-sync-secret") ?? "",
    Deno.env.get("PROVIDER_STATUS_SYNC_CRON_SECRET")?.trim());
  if (!cronAuthorized && !authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in to refresh order status." });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = readSecret("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readSecret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const token = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const base = (Deno.env.get("HUBNET_API_BASE_URL")?.trim() || "https://hubnet.app").replace(/\/+$/, "");
  if (!url || !anonKey || !serviceKey || !token) return json(503, { error: "Hubnet order status is not configured." });
  try {
    const parsedBase = new URL(base);
    if (parsedBase.protocol !== "https:" || parsedBase.hostname !== "hubnet.app" || parsedBase.username || parsedBase.password) throw new Error();
  } catch { return json(503, { error: "Hubnet API origin is not valid." }); }

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let profile: { role?: string | null } | null = null;
  let userId: string | null = null;
  if (!cronAuthorized) {
    const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization! } } });
    const { data: authData, error: authError } = await auth.auth.getUser();
    if (authError || !authData.user) return json(401, { error: "Your session expired. Sign in again." });
    userId = authData.user.id;
    const { data } = await service.from("profiles").select("role").eq("id", authData.user.id).maybeSingle();
    profile = data;
  }
  let ordersQuery = service.from("orders")
    .select("id,delivery_reference,payment_reference,delivery_status,provider_transaction_id,last_provider_status_checked_at")
    .eq("is_demo", false).eq("payment_status", "successful").eq("delivery_provider", "hubnet")
    .in("delivery_status", ["queued", "processing", "unknown"])
    .order("last_provider_status_checked_at", { ascending: true, nullsFirst: true }).limit(40);
  if (!cronAuthorized && profile?.role !== "admin") {
    if (!userId) return json(401, { error: "Your session expired. Sign in again." });
    ordersQuery = ordersQuery.or(`user_id.eq.${userId},referred_by_agent_id.eq.${userId}`);
  }
  const { data: orders, error } = await ordersQuery;
  if (error) return json(500, { error: "Pending Hubnet orders could not be loaded." });

  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  let updated = 0;
  let lookupErrors = 0;
  let statusUnavailable = 0;
  let updateErrors = 0;
  const queue = [...(orders ?? [])];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
   while (queue.length) {
    const order = queue.shift()!;
    if (!order.delivery_reference) continue;
    try {
      const checkUrl = new URL(`${base}/live/api/context/business/transaction/check-transaction-status`);
      const candidates = [...new Set([hubnetReference(order.delivery_reference), order.delivery_reference])];
      let response: Response | null = null;
      let payload: any = null;
      for (const candidate of candidates) {
        checkUrl.searchParams.set("reference", candidate);
        response = await fetch(checkUrl, {
          headers: { token: authHeader, Accept: "application/json" },
          signal: AbortSignal.timeout(7000),
        });
        payload = await response.json().catch(() => null);
        const candidateEnvelope = payload?.response ?? payload;
        if (response.ok && (candidateEnvelope?.status === true || candidateEnvelope?.status === "success" || payload?.status === true || payload?.status === "success")) break;
      }
      if (!response) {
        lookupErrors++;
        return;
      }
      const envelope = payload?.response ?? payload;
      const confirmed = envelope?.status === true || envelope?.status === "success" ||
        payload?.status === true || payload?.status === "success";
      if (!response.ok || !confirmed) {
        lookupErrors++;
        console.warn("Hubnet status lookup was not confirmed", {
          reference: hubnetReference(order.delivery_reference),
          httpStatus: response.status,
        });
        return;
      }
      const deliveryStatus = extractStatus(payload);
      if (!deliveryStatus) {
        statusUnavailable++;
        console.warn("Hubnet returned no recognized delivery status", {
          reference: hubnetReference(order.delivery_reference),
        });
        return;
      }
      const savedReference = String(order.provider_transaction_id ?? "").trim();
      const fallbackReference = savedReference && savedReference !== order.delivery_reference
        ? savedReference
        : hubnetReference(order.delivery_reference);
      const returnedReference = [envelope?.transaction_id, envelope?.tracking_id]
        .find((value) => typeof value === "string" || typeof value === "number");
      const resolvedReference = returnedReference === undefined
        ? fallbackReference
        : String(returnedReference).trim() || fallbackReference;
      if (deliveryStatus === order.delivery_status && resolvedReference === savedReference) return;
      const { error: updateError } = await service.rpc("update_live_order_delivery", {
        p_reference: order.delivery_reference,
        p_delivery_status: deliveryStatus,
        p_provider_transaction_id: resolvedReference,
      });
      if (updateError) {
        updateErrors++;
        console.error("Could not save Hubnet status lookup", {
          reference: hubnetReference(order.delivery_reference),
          error: updateError.message,
        });
        return;
      }
      updated++;
    } catch (error) {
      lookupErrors++;
      console.error("Hubnet status request failed", {
        reference: hubnetReference(order.delivery_reference),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    finally {
      await service.from("orders").update({ last_provider_status_checked_at: new Date().toISOString() }).eq("id", order.id);
    }
   }
  });
  await Promise.all(workers);
  return json(200, { success: true, checked: orders?.length ?? 0, updated, lookup_errors: lookupErrors, status_unavailable: statusUnavailable, update_errors: updateErrors });
});
