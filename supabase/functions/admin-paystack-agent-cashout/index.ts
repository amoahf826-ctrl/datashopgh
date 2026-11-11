import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers });

function readSecret(legacy: string, collection: string): string | undefined {
  const direct = Deno.env.get(legacy)?.trim();
  if (direct) return direct;
  try {
    const values = JSON.parse(Deno.env.get(collection) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    return Object.values(values).find((value) => typeof value === "string") as string | undefined;
  } catch { return undefined; }
}

async function paystack(path: string, secret: string, method: "GET" | "POST", body?: Record<string, unknown>) {
  const result = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await result.json().catch(() => null);
  return { ok: result.ok && data?.status === true, data, message: typeof data?.message === "string" ? data.message : "Paystack transfer request failed." };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return reply(401, { error: "Sign in to request an agent profit payout." });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = readSecret("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readSecret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  if (!url || !anon || !serviceKey || !paystackSecret) return reply(503, { error: "Paystack payouts are not configured. Check Supabase secrets and PAYSTACK_SECRET_KEY." });

  const auth = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData.user) return reply(401, { error: "Your session expired. Sign in again." });
  let body: { request_id?: unknown; action?: unknown; otp?: unknown; amount?: unknown };
  try { body = await request.json(); } catch { return reply(400, { error: "Request body must be JSON." }); }
  const { data: isAdmin, error: roleError } = await auth.rpc("is_admin");
  if (roleError) return reply(503, { error: "Could not verify administrator permissions." });
  if (body.action === "request") {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 1 || Math.round(amount * 100) !== amount * 100) {
      return reply(400, { error: "Enter a cashout amount of at least GHS 1.00 with up to two decimal places." });
    }
    const { data: requestId, error } = await auth.rpc("agent_request_cashout", { p_amount: amount });
    if (error || typeof requestId !== "string") return reply(409, { error: error?.message ?? "Could not create the cashout request." });
    body.request_id = requestId;
    body.action = "initiate";
  }
  if (typeof body.request_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.request_id) || !["initiate", "finalize"].includes(String(body.action))) {
    return reply(400, { error: "Choose a valid cashout request and payout action." });
  }
  if (!isAdmin && body.action !== "initiate") return reply(403, { error: "Administrator access required for this payout action." });

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let cashout: Record<string, any>;
  if (body.action === "initiate") {
    // Use the caller's JWT so the database can enforce that agents can only
    // initiate payouts for their own requests. Admins may initiate any request.
    const { data, error } = await auth.rpc("admin_prepare_agent_cashout_transfer", { p_request_id: body.request_id });
    if (error || !data) return reply(409, { error: error?.message ?? "Could not prepare this cashout." });
    cashout = data;
  } else {
    const { data, error } = await service.from("agent_cashout_requests")
      .select("id,amount,payout_amount,status,paystack_transfer_reference,paystack_transfer_code,paystack_transfer_status")
      .eq("id", body.request_id).maybeSingle();
    if (error || !data) return reply(404, { error: "Cashout request not found." });
    if (data.status !== "processing" || data.paystack_transfer_status !== "otp" || !data.paystack_transfer_code) {
      return reply(409, { error: "This cashout is not waiting for a Paystack OTP." });
    }
    if (typeof body.otp !== "string" || !/^\d{4,10}$/.test(body.otp.trim())) return reply(400, { error: "Enter the Paystack transfer OTP." });
    const finalized = await paystack("/transfer/finalize_transfer", paystackSecret, "POST", { transfer_code: data.paystack_transfer_code, otp: body.otp.trim() });
    if (!finalized.ok) return reply(502, { error: finalized.message });
    const transferStatus = String(finalized.data?.data?.status ?? "pending").toLowerCase();
    const transferData = finalized.data?.data ?? {};
    if (transferData.reference !== data.paystack_transfer_reference || transferData.currency !== "GHS" || transferData.amount !== Math.round(Number(data.payout_amount ?? data.amount) * 100)) {
      return reply(502, { error: "Paystack returned transfer details that do not match this cashout. Check Paystack before taking further action." });
    }
    const success = transferStatus === "success";
    const { error: saveError } = await service.from("agent_cashout_requests").update({
      status: success ? "paid" : "processing",
      paystack_transfer_status: transferStatus === "otp" ? "otp" : transferStatus === "success" ? "success" : "queued",
      paystack_error: null,
      payout_reference: success ? data.paystack_transfer_reference : null,
      processed_by: success ? userData.user.id : null,
      processed_at: success ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq("id", body.request_id);
    if (saveError) return reply(500, { error: "Paystack accepted the confirmation, but the cashout status could not be saved. Refresh the cashout queue." });
    return reply(200, { success: true, transfer_status: transferStatus, message: success ? "Paystack confirmed the MoMo payout." : "Paystack accepted the transfer; waiting for final confirmation." });
  }

  let recipientCode = String(cashout.recipient_code ?? "");
  if (!recipientCode) {
    const bankCode: Record<string, string> = { MTN: "MTN", TELECEL: "VOD", AT: "ATL" };
    const network = String(cashout.momo_network ?? "").toUpperCase();
    if (!bankCode[network]) return reply(400, { error: "This MoMo network is not supported for Paystack transfers." });
    const recipient = await paystack("/transferrecipient", paystackSecret, "POST", {
      type: "mobile_money", name: String(cashout.name ?? "CheapDataBundle Agent"),
      account_number: String(cashout.momo_phone), bank_code: bankCode[network], currency: "GHS",
      description: `Agent profit cashout ${String(cashout.id)}`,
    });
    recipientCode = String(recipient.data?.data?.recipient_code ?? "");
    if (!recipient.ok || !recipientCode) {
      await service.from("agent_cashout_requests").update({ paystack_transfer_status: "failed", paystack_error: recipient.message, updated_at: new Date().toISOString() }).eq("id", body.request_id);
      return reply(502, { error: `Paystack could not register the agent's MoMo account: ${recipient.message}` });
    }
    const { error: recipientSaveError } = await service.from("agent_cashout_requests").update({ paystack_recipient_code: recipientCode, updated_at: new Date().toISOString() }).eq("id", body.request_id);
    if (recipientSaveError) return reply(500, { error: "Paystack recipient was created, but its reference could not be saved. Refresh and retry this cashout." });
  }

  const amountPesewas = Math.round(Number(cashout.payout_amount ?? cashout.amount) * 100);
  if (!Number.isSafeInteger(amountPesewas) || amountPesewas < 1000) return reply(400, { error: "Net MoMo payout must be at least GHS 10.00." });
  const transfer = await paystack("/transfer", paystackSecret, "POST", {
    source: "balance", amount: amountPesewas, recipient: recipientCode,
    reference: String(cashout.reference), currency: "GHS",
    reason: `CheapDataBundle agent profit cashout ${String(cashout.id).slice(0, 8)}`,
  });
  if (!transfer.ok) {
    await service.from("agent_cashout_requests").update({ paystack_transfer_status: "failed", paystack_error: transfer.message, updated_at: new Date().toISOString() }).eq("id", body.request_id);
    return reply(502, { error: `Paystack could not send this payout: ${transfer.message}` });
  }
  const transferData = transfer.data?.data ?? {};
  const transferStatus = String(transferData.status ?? "pending").toLowerCase();
  const requiresOtp = transferStatus === "otp";
  const success = transferStatus === "success";
  if (transferData.reference !== cashout.reference || transferData.currency !== "GHS" || transferData.amount !== amountPesewas) {
    await service.from("agent_cashout_requests").update({ paystack_transfer_status: "failed", paystack_error: "Paystack transfer details did not match the cashout request.", updated_at: new Date().toISOString() }).eq("id", body.request_id);
    return reply(502, { error: "Paystack returned transfer details that do not match this cashout. Check Paystack before retrying." });
  }
  if (requiresOtp && typeof transferData.transfer_code !== "string") {
    await service.from("agent_cashout_requests").update({ paystack_transfer_status: "failed", paystack_error: "Paystack requested OTP confirmation but did not return a transfer code.", updated_at: new Date().toISOString() }).eq("id", body.request_id);
    return reply(502, { error: "Paystack requested an OTP but returned no transfer code. Check Paystack transfers before retrying." });
  }
  const { error: saveError } = await service.from("agent_cashout_requests").update({
    paystack_recipient_code: recipientCode,
    paystack_transfer_code: transferData.transfer_code ?? null,
    paystack_transfer_status: requiresOtp ? "otp" : success ? "success" : "queued",
    paystack_error: null,
    status: success ? "paid" : "processing",
    payout_reference: success ? cashout.reference : null,
    processed_by: success ? userData.user.id : null,
    processed_at: success ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", body.request_id);
  if (saveError) return reply(500, { error: "Paystack received the payout request, but its status could not be saved. Refresh the queue and check Paystack before retrying." });
  return reply(200, {
    success: true, request_id: cashout.id, transfer_status: transferStatus,
    requested_amount: Number(cashout.amount), admin_fee_amount: Number(cashout.admin_fee_amount ?? 0), payout_amount: Number(cashout.payout_amount ?? cashout.amount),
    requires_otp: requiresOtp,
    message: success ? "Paystack confirmed the MoMo payout." : requiresOtp ? "Paystack requires the transfer OTP sent to your business contact." : "Paystack accepted the payout. Waiting for transfer confirmation.",
  });
});
