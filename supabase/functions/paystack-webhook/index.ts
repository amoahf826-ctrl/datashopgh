import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const response = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function readSupabaseServiceKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;
  try {
    const values = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

async function validSignature(raw: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expected = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (signature.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return response(405, { error: "Method not allowed." });
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = readSupabaseServiceKey();
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const hubnetBase = Deno.env.get("HUBNET_API_BASE_URL")?.trim().replace(/\/+$/, "");
  if (!secret || !supabaseUrl || !serviceKey) return response(503, { error: "Paystack webhook service is not configured." });

  const raw = await request.text();
  const signature = request.headers.get("x-paystack-signature") ?? "";
  if (!await validSignature(raw, signature, secret)) return response(401, { error: "Invalid webhook signature." });

  let event: any;
  try { event = JSON.parse(raw); } catch { return response(400, { error: "Invalid JSON." }); }
  if (event?.event !== "charge.success" || typeof event?.data?.reference !== "string") return response(200, { received: true });

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const reference = event.data.reference as string;

  const { data: deposit, error: depositError } = await service.from("deposits")
    .select("id,amount,status").eq("provider", "paystack").eq("provider_reference", reference).maybeSingle();
  if (depositError) return response(500, { error: "Could not load the wallet deposit." });
  if (deposit) {
    if (deposit.status === "successful") return response(200, { received: true, duplicate: true });
    if (deposit.status !== "pending") return response(200, { received: true, ignored: true });
    try {
      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      const result = await verified.json().catch(() => null);
      const transaction = result?.data;
      if (!verified.ok || result?.status !== true || transaction?.status !== "success" ||
          transaction?.reference !== reference || transaction?.currency !== "GHS" ||
          Number(transaction?.amount) !== Math.round(Number(deposit.amount) * 100)) {
        return response(200, { received: true, verified: false });
      }
      const { error: claimError } = await service.rpc("claim_paystack_wallet_deposit", {
        p_reference: reference, p_amount: Number(transaction.amount), p_currency: transaction.currency,
      });
      if (claimError) return response(500, { error: "Verified wallet payment could not be credited." });
      return response(200, { received: true, walletDeposit: true });
    } catch {
      return response(500, { error: "Could not verify the wallet payment; Paystack may retry this webhook." });
    }
  }

  const { data: existing, error: orderError } = await service.from("orders")
    .select("id,payment_reference,price,payment_status,delivery_status")
    .eq("payment_reference", reference).maybeSingle();
  if (orderError) return response(500, { error: "Could not load the order." });
  if (!existing) return response(200, { received: true });
  if (existing.payment_status === "successful") return response(200, { received: true, duplicate: true });
  if (!hubnetToken || !hubnetBase) return response(503, { error: "Hubnet delivery is not configured; Paystack may retry this webhook." });

  let verification: any;
  try {
    const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    verification = await verified.json().catch(() => null);
    if (!verified.ok || verification?.status !== true || verification?.data?.status !== "success" ||
        verification.data.reference !== reference || verification.data.currency !== "GHS" ||
        Number(verification.data.amount) !== Math.round(Number(existing.price) * 100)) {
      return response(200, { received: true, verified: false });
    }
  } catch {
    return response(500, { error: "Could not verify payment; Paystack may retry this webhook." });
  }

  const { data: claim, error: claimError } = await service.rpc("claim_paid_order", {
    p_reference: reference,
    p_amount: Number(verification.data.amount),
    p_currency: verification.data.currency,
  });
  if (claimError) return response(500, { error: "Verified payment could not be reconciled." });
  if (!claim?.newly_paid) return response(200, { received: true, duplicate: true });

  const networkMap: Record<string, string> = { MTN: "mtn", Telecel: "telecel", AT: "at" };
  const network = networkMap[String(claim.network)];
  const size = String(claim.size ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
  if (!network || !size) {
    await service.rpc("update_live_order_delivery", { p_reference: claim.delivery_reference, p_delivery_status: "failed" });
    return response(200, { received: true, delivered: false });
  }
  const volume = String(Math.round(Number(size[1]) * (size[2].toUpperCase() === "GB" ? 1000 : 1)));
  const tokenHeader = /^Bearer\s+/i.test(hubnetToken) ? hubnetToken : `Bearer ${hubnetToken}`;
  const webhookUrl = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/hubnet-webhook`;
  try {
    const delivery = await fetch(`${hubnetBase}/live/api/context/business/transaction/${network}-new-transaction`, {
      method: "POST",
      headers: { token: tokenHeader, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: claim.phone, volume, reference: claim.delivery_reference, webhook: webhookUrl }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await delivery.json().catch(() => null);
    const envelope = result?.response ?? result;
    const resultData = envelope?.data ?? result?.data ?? {};
    const resultStatus = String(resultData?.status ?? envelope?.status ?? "").toLowerCase();
    const providerId = envelope?.transaction_id ?? resultData?.transaction_id ?? null;
    if (delivery.ok && (resultStatus === "true" || resultStatus === "success" || resultStatus === "processing" || resultStatus === "pending")) {
      const final = ["success", "delivered", "completed"].includes(String(resultData?.status).toLowerCase());
      await service.rpc("update_live_order_delivery", {
        p_reference: claim.delivery_reference,
        p_delivery_status: final ? "delivered" : "processing",
        p_provider_transaction_id: providerId,
      });
    } else if (resultStatus === "failed" || resultStatus === "cancelled") {
      await service.rpc("update_live_order_delivery", {
        p_reference: claim.delivery_reference, p_delivery_status: "failed", p_provider_transaction_id: providerId,
      });
    } else {
      await service.rpc("update_live_order_delivery", { p_reference: claim.delivery_reference, p_delivery_status: "unknown" });
    }
  } catch {
    // A timeout can happen after Hubnet accepted the request. Keep it unknown to prevent accidental duplicate delivery.
    await service.rpc("update_live_order_delivery", { p_reference: claim.delivery_reference, p_delivery_status: "unknown" });
  }
  return response(200, { received: true });
});
