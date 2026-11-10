import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
  let signedInUser: { id: string; email?: string } | null = null;
  if (authorization?.startsWith("Bearer ")) {
    const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data } = await authClient.auth.getUser();
    if (data.user?.email) signedInUser = { id: data.user.id, email: data.user.email };
  }

  let base: URL;
  try { base = new URL(appBase); } catch { return json(503, { error: "APP_BASE_URL must be a valid HTTPS URL." }); }
  if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash) {
    return json(503, { error: "APP_BASE_URL must be a secure site origin." });
  }

  let body: { bundle_id?: unknown; recipient_phone?: unknown; idempotency_key?: unknown; agent_referral_code?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (typeof body.bundle_id !== "string" || body.bundle_id.length > 100 ||
      typeof body.recipient_phone !== "string" || !/^0\d{9}$/.test(body.recipient_phone) ||
      typeof body.idempotency_key !== "string" || !/^[0-9a-f-]{36}$/i.test(body.idempotency_key) ||
      (body.agent_referral_code != null && (typeof body.agent_referral_code !== "string" || body.agent_referral_code.length > 80))) {
    return json(400, { error: "Choose a bundle and enter a valid Ghana phone number." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: setting, error: settingError } = await service.from("platform_settings")
    .select("value").eq("key", "storefront_live_sales").maybeSingle();
  if (settingError || setting?.value?.enabled !== true) return json(503, { error: "Live checkout is not enabled yet." });

  const orderId = crypto.randomUUID();
  const paystackReference = `DSGH-${crypto.randomUUID().replaceAll("-", "")}`;
  const deliveryReference = `DS${orderId.replaceAll("-", "").slice(0, 23)}`;
  const referralCode = typeof body.agent_referral_code === "string" ? body.agent_referral_code : null;
  const created = signedInUser
    ? await service.rpc("create_live_checkout_order", {
      p_user_id: signedInUser.id, p_bundle_id: body.bundle_id, p_recipient_phone: body.recipient_phone,
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
  if (order.checkout_url) return json(200, { authorization_url: order.checkout_url, reference: order.payment_reference });

  const { data: feeSetting, error: feeSettingError } = await service.from("platform_settings")
    .select("value").eq("key", "paystack_fee_recovery").maybeSingle();
  if (feeSettingError) return json(503, { error: "Could not load the Paystack fee configuration. Please retry shortly." });
  const feeEnabled = feeSetting?.value?.enabled === true;
  const ratePercent = feeEnabled ? Number(feeSetting?.value?.rate_percent) : 0;
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 10) {
    return json(503, { error: "The Paystack fee configuration is invalid. Contact the administrator." });
  }

  const callback = new URL(base.origin);
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
      body: JSON.stringify({ email: signedInUser?.email ?? `guest-${String(body.idempotency_key).toLowerCase()}@checkout.cheapdatabundle.com`, amount: chargeCents, currency: "GHS", reference: order.payment_reference,
        callback_url: callback.toString(), metadata: { order_id: order.id, delivery_reference: deliveryReference,
          bundle_amount: Number(order.price), fee_amount: feeAmount, charge_amount: chargeAmount } }),
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
    return json(200, { authorization_url: result.data.authorization_url, reference: order.payment_reference,
      bundle_amount: Number(order.price), fee_amount: feeAmount, charge_amount: chargeAmount });
  } catch {
    return json(502, { error: "Could not reach Paystack. No payment was taken." });
  }
});
