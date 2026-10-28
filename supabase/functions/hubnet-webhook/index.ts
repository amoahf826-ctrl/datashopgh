import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
  const reference = body?.reference ?? body?.data?.reference;
  if (typeof reference !== "string" || !/^DS[A-Fa-f0-9]{23}$/.test(reference)) return json(400, { error: "Valid order reference is required." });

  const authHeader = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  try {
    const checkUrl = new URL(`${base}/live/api/context/business/transaction/check-transaction-status`);
    checkUrl.searchParams.set("reference", reference);
    const checked = await fetch(checkUrl, {
      headers: { token: authHeader, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const result = await checked.json().catch(() => null);
    const envelope = result?.response ?? result;
    const data = envelope?.data ?? result?.data ?? {};
    if (!checked.ok || !(envelope?.status === true || envelope?.status === "success" || result?.status === true || result?.status === "success")) return json(200, { received: true, verified: false });
    const state = String(data?.status ?? "").toLowerCase();
    const deliveryStatus = ["success", "delivered", "completed"].includes(state) ? "delivered"
      : ["failed", "cancelled"].includes(state) ? "failed"
      : ["pending", "processing"].includes(state) ? "processing" : null;
    if (!deliveryStatus) return json(200, { received: true, verified: false });

    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await service.rpc("update_live_order_delivery", {
      p_reference: reference,
      p_delivery_status: deliveryStatus,
      p_provider_transaction_id: envelope?.transaction_id ?? data?.transaction_id ?? null,
    });
    if (error) return json(500, { error: "Verified status could not be saved." });
    if (deliveryStatus === "failed") {
      const { error: refundError } = await service.rpc("refund_failed_wallet_bundle_order", {
        p_delivery_reference: reference,
      });
      if (refundError) return json(500, { error: "Verified delivery failure was saved, but wallet refund needs reconciliation." });
    }
    return json(200, { received: true, verified: true });
  } catch {
    return json(500, { error: "Could not verify provider status." });
  }
});
