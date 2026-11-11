import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const response = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function normalizeDeliveryStatus(value: unknown): "delivered" | "failed" | "processing" | null {
  const status = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCESSFUL", "DELIVERED", "COMPLETED", "COMPLETE"].includes(status)) return "delivered";
  if (["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "REFUNDED"].includes(status)) return "failed";
  if (["PENDING", "QUEUED", "PROCESSING", "IN_PROGRESS", "ACCEPTED"].includes(status)) return "processing";
  return null;
}

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
  const datahubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
  const appBase = (Deno.env.get("APP_BASE_URL")?.trim() || "https://cheapdatabundle.wittymultimedia.com").replace(/\/+$/, "");
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
    .select("id,amount,fee_amount,charge_amount,status").eq("provider", "paystack").eq("provider_reference", reference).maybeSingle();
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
      const requestedAmount = transaction?.requested_amount;
      if (!verified.ok || result?.status !== true || transaction?.status !== "success" ||
          transaction?.reference !== reference || transaction?.currency !== "GHS" ||
          !Number.isSafeInteger(transaction?.amount) || !Number.isSafeInteger(requestedAmount) ||
          transaction.amount < requestedAmount || requestedAmount !== Math.round(Number(deposit.charge_amount ?? deposit.amount) * 100)) {
        return response(200, { received: true, verified: false });
      }
      const { error: claimError } = await service.rpc("claim_paystack_wallet_deposit", {
        p_reference: reference, p_amount: requestedAmount, p_currency: transaction.currency,
      });
      if (claimError) return response(500, { error: "Verified wallet payment could not be credited." });
      return response(200, { received: true, walletDeposit: true });
    } catch {
      return response(500, { error: "Could not verify the wallet payment; Paystack may retry this webhook." });
    }
  }

  const { data: existing, error: orderError } = await service.from("orders")
    .select("id,payment_reference,price,fee_amount,charge_amount,payment_status,delivery_status")
    .eq("payment_reference", reference).maybeSingle();
  if (orderError) return response(500, { error: "Could not load the order." });
  if (!existing) return response(200, { received: true });
  if (existing.payment_status === "successful") return response(200, { received: true, duplicate: true });
  const { data: providerSetting, error: providerSettingError } = await service.from("platform_settings")
    .select("value").eq("key", "active_bundle_provider").maybeSingle();
  if (providerSettingError) return response(503, { error: "Could not read the active bundle provider; Paystack may retry this webhook." });
  const activeProvider = providerSetting?.value?.provider === "hubnet" ? "hubnet" : "datahub";
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const hubnetBase = (Deno.env.get("HUBNET_API_BASE_URL")?.trim() || "https://console.hubnet.app").replace(/\/+$/, "");
  if (activeProvider === "datahub" && !datahubKey) return response(503, { error: "DataHub delivery is not configured; Paystack may retry this webhook." });
  let appOrigin: string;
  try {
    const base = new URL(appBase);
    if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash) throw new Error();
    appOrigin = base.origin;
  } catch { return response(503, { error: "APP_BASE_URL must be a secure site origin." }); }
  if (activeProvider === "hubnet" && !hubnetToken) return response(503, { error: "Hubnet delivery is not configured; Paystack may retry this webhook." });
  if (activeProvider === "hubnet") {
    try { const base = new URL(hubnetBase); if (base.protocol !== "https:" || base.hostname !== "console.hubnet.app" || base.username || base.password) throw new Error(); }
    catch { return response(503, { error: "HUBNET_API_BASE_URL must use the verified Hubnet HTTPS origin." }); }
  }

  let verification: any;
  let verifiedRequestedAmount = 0;
  try {
    const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    verification = await verified.json().catch(() => null);
    const requestedAmount = verification?.data?.requested_amount;
    if (!verified.ok || verification?.status !== true || verification?.data?.status !== "success" ||
        verification.data.reference !== reference || verification.data.currency !== "GHS" ||
        !Number.isSafeInteger(verification.data.amount) || !Number.isSafeInteger(requestedAmount) ||
        verification.data.amount < requestedAmount || requestedAmount !== Math.round(Number(existing.charge_amount ?? existing.price) * 100)) {
      return response(200, { received: true, verified: false });
    }
    verifiedRequestedAmount = requestedAmount;
  } catch {
    return response(500, { error: "Could not verify payment; Paystack may retry this webhook." });
  }

  const { data: claim, error: claimError } = await service.rpc("claim_paid_order", {
    p_reference: reference,
    p_amount: verifiedRequestedAmount,
    p_currency: verification.data.currency,
  });
  if (claimError) return response(500, { error: "Verified payment could not be reconciled." });
  if (!claim?.newly_paid) return response(200, { received: true, duplicate: true });
  await service.from("orders").update({ delivery_provider: activeProvider }).eq("id", claim.order_id);

  const { data: orderRecord } = await service.from("orders").select("bundle_id").eq("id", claim.order_id).maybeSingle();
  const { data: plan } = orderRecord?.bundle_id
    ? await service.from("bundles").select("category,subcategory").eq("id", orderRecord.bundle_id).maybeSingle()
    : { data: null };
  const category = `${plan?.category ?? ""} ${plan?.subcategory ?? ""}`.toLowerCase();
  const networkKey = String(claim.network) === "MTN"
    ? "YELLO"
    : String(claim.network) === "Telecel" ? "TELECEL"
    : String(claim.network) === "AT" ? (/big[\s-]?time/.test(category) ? "AT_BIGTIME" : "AT_PREMIUM") : null;
  const size = String(claim.size ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
  if (!networkKey || !size) {
    await service.rpc("update_live_order_delivery", { p_reference: claim.delivery_reference, p_delivery_status: "failed" });
    return response(200, { received: true, delivered: false });
  }
  const capacity = String(Number((Number(size[1]) * (size[2].toUpperCase() === "GB" ? 1 : 0.001)).toFixed(3)));
  const webhook = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/hubnet-webhook`;
  try {
    let delivery: Response;
    if (activeProvider === "datahub") {
      delivery = await fetch("https://user.datahubgh.com/api/external/data-purchase", {
        method: "POST",
        headers: { "X-API-Key": datahubKey!, "Content-Type": "application/json", Accept: "application/json", Origin: appOrigin, Referer: `${appOrigin}/` },
        body: JSON.stringify({ networkKey, recipient: claim.phone, capacity }),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      const hubnetPath = networkKey === "AT_BIGTIME" ? "big-time-new-transaction"
        : networkKey === "TELECEL" ? "telecel-new-transaction"
        : networkKey === "AT_PREMIUM" ? "at-new-transaction"
        : "mtn-new-transaction";
      const volume = String(Math.round(Number(size[1]) * (size[2].toUpperCase() === "GB" ? 1000 : 1)));
      const endpoint = `${hubnetBase}/live/api/context/business/transaction/${hubnetPath}`;
      const authHeader = /^Bearer\s+/i.test(hubnetToken!) ? hubnetToken! : `Bearer ${hubnetToken}`;
      delivery = await fetch(endpoint, {
        method: "POST",
        headers: { token: authHeader, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ phone: claim.phone, volume, reference: claim.delivery_reference, webhook }),
        signal: AbortSignal.timeout(15000),
      });
    }
    const result = await delivery.json().catch(() => null);
    const envelope = activeProvider === "hubnet" ? (result?.response ?? result) : result;
    const resultData = envelope?.data ?? result?.data ?? {};
    const accepted = activeProvider === "hubnet"
      ? (envelope?.status === true || envelope?.status === "success" || result?.success === true || result?.status === "success")
      : result?.success === true;
    const providerStatus = normalizeDeliveryStatus(resultData.status ?? resultData.delivery_status ?? resultData.orderStatus ?? resultData.order_status);
    if (delivery.ok && accepted && (providerStatus === "failed" || activeProvider === "hubnet" || typeof resultData.reference === "string")) {
      const transactionReference = resultData.reference ?? resultData.transaction_id ?? resultData.tracking_id ?? claim.delivery_reference;
      await service.rpc("update_live_order_delivery", {
        p_reference: claim.delivery_reference,
        p_delivery_status: providerStatus ?? "unknown",
        p_provider_transaction_id: transactionReference,
      });
    } else if (delivery.ok && result?.success === true) {
      await service.rpc("update_live_order_delivery", { p_reference: claim.delivery_reference, p_delivery_status: "unknown" });
    } else if (delivery.status >= 400 && delivery.status < 500) {
      await service.rpc("update_live_order_delivery", {
        p_reference: claim.delivery_reference, p_delivery_status: "failed",
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
