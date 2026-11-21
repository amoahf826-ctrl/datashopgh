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

function secret(legacy: string, collection: string): string | undefined {
  const direct = Deno.env.get(legacy)?.trim();
  if (direct) return direct;
  try {
    const values = JSON.parse(Deno.env.get(collection) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    return Object.values(values).find((value): value is string => typeof value === "string");
  } catch { return undefined; }
}

function normalizeStatus(value: unknown): string | null {
  const status = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(status)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(status)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(status)) return "processing";
  return null;
}

function extractStatus(payload: any): string | null {
  const queue = [payload];
  const seen = new Set<object>();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const key of ["delivery_status", "deliveryStatus", "order_status", "orderStatus"]) {
      const status = normalizeStatus(value[key]);
      if (status) return status;
    }
    for (const key of ["response", "data", "transaction", "order", "result", "details"]) {
      if (value[key] && typeof value[key] === "object") queue.push(value[key]);
    }
  }
  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in is required." });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = secret("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = secret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !anonKey || !serviceKey) return json(503, { error: "Complaint status service is not configured." });

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session expired. Sign in again." });
  const { data: profile, error: profileError } = await auth.from("profiles").select("role").eq("id", authData.user.id).maybeSingle();
  if (profileError) return json(503, { error: "Could not verify administrator access." });
  if (profile?.role !== "admin") return json(403, { error: "Administrator access is required." });

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: complaints, error } = await service.from("order_complaints")
    .select("order_id,orders!inner(id,delivery_provider,delivery_reference,delivery_status,status,payment_status,provider_transaction_id)")
    .order("created_at", { ascending: false }).limit(100);
  if (error) return json(500, { error: "Could not load complaint orders for provider status checks." });

  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const hubnetBase = (Deno.env.get("HUBNET_API_BASE_URL")?.trim() || "https://hubnet.app").replace(/\/+$/, "");
  let validHubnetBase = false;
  try {
    const parsed = new URL(hubnetBase);
    validHubnetBase = parsed.protocol === "https:" && parsed.hostname === "hubnet.app" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { /* Invalid configuration remains unavailable, without disclosing details. */ }
  const orders: Record<string, { status: string; provider: string; source: string; available: boolean }> = {};
  let checked = 0;
  let updated = 0;
  let unavailable = 0;
  const hubnetAuth = hubnetToken ? (/^Bearer\s+/i.test(hubnetToken) ? hubnetToken : `Bearer ${hubnetToken}`) : "";

  await Promise.all((complaints ?? []).map(async (complaint: any) => {
    const order = Array.isArray(complaint.orders) ? complaint.orders[0] : complaint.orders;
    if (!order) return;
    const provider = String(order.delivery_provider ?? "").toLowerCase();
    const initial = String(order.delivery_status ?? order.status ?? "unknown");
    if (provider !== "hubnet") {
      // DataHub status is synchronized from its signed status callback and kept on the order record.
      orders[complaint.order_id] = { status: initial, provider: provider || "unknown", source: provider === "datahub" ? "DataHub callback" : "saved order status", available: true };
      return;
    }
    if (!order.delivery_reference || !hubnetToken || !validHubnetBase) {
      unavailable++;
      orders[complaint.order_id] = { status: initial, provider: "hubnet", source: "saved order status", available: false };
      return;
    }
    try {
      const checkUrl = new URL(`${hubnetBase}/live/api/context/business/transaction/check-transaction-status`);
      const candidates = [...new Set([hubnetReference(order.delivery_reference), order.delivery_reference])];
      let response: Response | null = null;
      let payload: any = null;
      for (const candidate of candidates) {
        checkUrl.searchParams.set("reference", candidate);
        response = await fetch(checkUrl, { headers: { token: hubnetAuth, Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
        payload = await response.json().catch(() => null);
        const candidateEnvelope = payload?.response ?? payload;
        if (response.ok && (candidateEnvelope?.status === true || candidateEnvelope?.status === "success" || payload?.status === true || payload?.status === "success")) break;
      }
      if (!response) return;
      const envelope = payload?.response ?? payload;
      const confirmed = envelope?.status === true || envelope?.status === "success" || payload?.status === true || payload?.status === "success";
      const live = response.ok && confirmed ? extractStatus(payload) : null;
      checked++;
      if (live) {
        orders[complaint.order_id] = { status: live, provider: "hubnet", source: "Hubnet live API", available: true };
        updated++;
      } else {
        unavailable++;
        orders[complaint.order_id] = { status: initial, provider: "hubnet", source: "saved order status", available: false };
      }
    } catch {
      unavailable++;
      orders[complaint.order_id] = { status: initial, provider: "hubnet", source: "saved order status", available: false };
    }
  }));

  return json(200, { success: true, checked, updated, unavailable, checked_at: new Date().toISOString(), orders });
});
