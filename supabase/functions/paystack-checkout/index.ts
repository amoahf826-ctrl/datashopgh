import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyConfiguredNumber } from "../_shared/numberVerification.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  const appBase = Deno.env.get("APP_BASE_URL")?.trim().replace(/\/+$/, "");
  if (!supabaseUrl || !anonKey || !serviceKey || !paystackSecret?.startsWith("sk_live_") || !appBase) {
    return json(503, { error: "Live checkout is not fully configured on the server." });
  }

  const authorization = request.headers.get("Authorization");
  const suppliedApiKey = request.headers.get("x-agent-api-key")?.trim() ?? "";
  let signedInUser: { id: string; email?: string } | null = null;
  let partnerAgent: { id: string; referralCode: string } | null = null;
  if (!suppliedApiKey && authorization?.startsWith("Bearer ")) {
    const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data } = await authClient.auth.getUser();
    if (data.user?.email) signedInUser = { id: data.user.id, email: data.user.email };
  }

  let base: URL;
  try { base = new URL(appBase); } catch { return json(503, { error: "APP_BASE_URL must be a valid HTTPS URL." }); }
  if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash) {
    return json(503, { error: "APP_BASE_URL must be a secure site origin." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (suppliedApiKey) {
    if (!/^cdb_live_[0-9a-f]{64}$/i.test(suppliedApiKey)) return json(401, { error: "Invalid provider API key." });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(suppliedApiKey));
    const keyHash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const { data: keyRow, error: keyError } = await service.from("agent_partner_api_keys")
      .select("id,agent_id").eq("key_hash", keyHash).is("revoked_at", null).maybeSingle();
    if (keyError || !keyRow) return json(401, { error: "Invalid or revoked provider API key." });
    const { data: account, error: accountError } = await service.from("agent_accounts")
      .select("user_id,referral_code,is_active,deleted_at").eq("user_id", keyRow.agent_id).maybeSingle();
    if (accountError || !account?.is_active || account.deleted_at || !account.referral_code) {
      return json(403, { error: "This provider account is inactive." });
    }
    partnerAgent = { id: account.user_id, referralCode: account.referral_code };
    await service.from("agent_partner_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id);
  }

  let body: { bundle_id?: unknown; recipient_phone?: unknown; idempotency_key?: unknown; agent_referral_code?: unknown; customer_email?: unknown; callback_url?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (typeof body.bundle_id !== "string" || body.bundle_id.length > 100 ||
      typeof body.recipient_phone !== "string" || !/^0\d{9}$/.test(body.recipient_phone) ||
      typeof body.idempotency_key !== "string" || !/^[0-9a-f-]{36}$/i.test(body.idempotency_key) ||
      (body.agent_referral_code != null && (typeof body.agent_referral_code !== "string" || body.agent_referral_code.length > 80))) {
    return json(400, { error: "Choose a bundle and enter a valid Ghana phone number." });
  }

  if (partnerAgent && (typeof body.customer_email !== "string" || body.customer_email.length > 254 ||
      !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(body.customer_email.trim()))) {
    return json(400, { error: "A valid customer_email is required for Paystack receipts." });
  }
  let callbackUrl: URL;
  try {
    callbackUrl = !partnerAgent || body.callback_url == null ? new URL(base.origin) : new URL(String(body.callback_url));
    if (callbackUrl.protocol !== "https:" || callbackUrl.username || callbackUrl.password || callbackUrl.href.length > 1000) throw new Error();
  } catch { return json(400, { error: "callback_url must be a valid HTTPS URL." }); }

  const referralCode = partnerAgent?.referralCode ?? (typeof body.agent_referral_code === "string" ? body.agent_referral_code.trim().toUpperCase() : null);
  const { data: setting, error: settingError } = await service.from("platform_settings")
    .select("value").eq("key", "storefront_live_sales").maybeSingle();
  if (settingError || setting?.value?.enabled !== true) return json(503, { error: "Live checkout is not enabled yet." });

  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const verificationHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${referralCode || "main-store"}`));
  const verificationRateKey = `number-verification:${Array.from(new Uint8Array(verificationHash)).map(value => value.toString(16).padStart(2, "0")).join("")}`;
  const { data: verificationAllowed, error: verificationRateError } = await service.rpc("consume_public_number_verification_rate_limit", {
    p_rate_key: verificationRateKey, p_limit: 10,
  });
  if (verificationRateError) return json(503, { error: "Number verification is temporarily unavailable. No payment was started." });
  if (verificationAllowed !== true) return json(429, { error: "Too many number checks. Please wait a few minutes and try again. No payment was started." });
  const numberCheck = await verifyConfiguredNumber(service, body.recipient_phone);
  if ("error" in numberCheck) return json(502, { error: `${numberCheck.error} No payment was started.` });
  if (numberCheck.status !== "verified") {
    const reason = numberCheck.status === "unverified"
      ? "Phone Number is Not Verified. You can't buy Data Now.Check again Next Week untill your Number is Verified."
      : numberCheck.status === "queued"
        ? "Number verification is still processing. Please try again in a moment."
        : "This phone number could not be verified. Check the number and try again.";
    return json(422, { error: `${reason} No payment was started.`, verification_status: numberCheck.status });
  }

  const orderId = crypto.randomUUID();
  const paystackReference = `DSGH-${crypto.randomUUID().replaceAll("-", "")}`;
  const deliveryReference = `DS${orderId.replaceAll("-", "").slice(0, 23)}`;
  const created = signedInUser || partnerAgent
    ? await service.rpc("create_live_checkout_order", {
      p_user_id: partnerAgent?.id ?? signedInUser!.id, p_bundle_id: body.bundle_id, p_recipient_phone: body.recipient_phone,
      p_idempotency_key: body.idempotency_key, p_payment_reference: paystackReference,
      p_delivery_reference: deliveryReference, p_agent_referral_code: referralCode,
    })
    : await service.rpc("create_guest_live_checkout_order", {
      p_email: `guest-${String(body.idempotency_key).toLowerCase()}@checkout.cheapdatabundle.com`, p_bundle_id: body.bundle_id,
      p_recipient_phone: body.recipient_phone, p_idempotency_key: body.idempotency_key,
      p_payment_reference: paystackReference, p_delivery_reference: deliveryReference,
      p_agent_referral_code: referralCode,
      p_client_ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "",
    });
  const { data: order, error: orderError } = created;
  if (orderError || !order) return json(400, { error: orderError?.message ?? "Could not create the order." });
  if (order.rate_limited === true) return json(429, { error: "Too many checkout attempts. Wait a few minutes and try again." });
  if (order.checkout_url) return json(200, { success: true, order_id: order.id, authorization_url: order.checkout_url,
    reference: order.payment_reference, amount: Number(order.price), currency: "GHS" });

  const { data: feeSetting, error: feeSettingError } = await service.from("platform_settings")
    .select("value").eq("key", "paystack_fee_recovery").maybeSingle();
  if (feeSettingError) return json(503, { error: "Could not load the Paystack fee configuration. Please retry shortly." });
  const feeEnabled = feeSetting?.value?.enabled === true;
  const ratePercent = feeEnabled ? Number(feeSetting?.value?.rate_percent) : 0;
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 10) {
    return json(503, { error: "The Paystack fee configuration is invalid. Contact the administrator." });
  }

  const callback = callbackUrl;
  callback.searchParams.set("payment", "complete");
  callback.searchParams.set("reference", order.payment_reference);
  const baseCents = Math.round(Number(order.price) * 100);
  const feeCents = Math.round(baseCents * ratePercent / 100);
  const chargeCents = baseCents + feeCents;
  if (!Number.isSafeInteger(chargeCents) || baseCents < 100 || chargeCents > 1000000) {
    return json(400, { error: "Bundle price plus Paystack fee is outside the supported checkout limit." });
  }
  const feeAmount = feeCents / 100;
  const chargeAmount = chargeCents / 100;
  const { error: prepareError } = await service.rpc("prepare_paystack_order_charge", {
    p_order_id: order.id, p_fee_amount: feeAmount, p_charge_amount: chargeAmount,
  });
  if (prepareError) return json(409, { error: "The order fee quote changed or checkout is no longer pending. Start again." });

  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: partnerAgent ? String(body.customer_email).trim().toLowerCase() : signedInUser?.email ?? `guest-${String(body.idempotency_key).toLowerCase()}@checkout.cheapdatabundle.com`, amount: chargeCents, currency: "GHS", reference: order.payment_reference,
        callback_url: callback.toString(), metadata: { order_id: order.id, delivery_reference: deliveryReference,
          bundle_amount: Number(order.price), fee_amount: feeAmount, charge_amount: chargeAmount,
          ...(partnerAgent ? { integration: "agent_partner_api", agent_id: partnerAgent.id } : {}) } }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.status !== true || typeof result?.data?.authorization_url !== "string") {
      return json(502, { error: "Paystack could not start checkout. No payment was taken." });
    }
    const { error: saveError } = await service.rpc("save_live_checkout_url", {
      p_order_id: order.id, p_url: result.data.authorization_url, p_fee_amount: feeAmount, p_charge_amount: chargeAmount,
    });
    if (saveError) return json(502, { error: "Checkout started but could not be saved. Contact support before retrying." });
    return json(200, { success: true, order_id: order.id, authorization_url: result.data.authorization_url, reference: order.payment_reference,
      amount: Number(order.price), fee_amount: feeAmount, charge_amount: chargeAmount, currency: "GHS" });
  } catch {
    return json(502, { error: "Could not reach Paystack. No payment was taken." });
  }
});
