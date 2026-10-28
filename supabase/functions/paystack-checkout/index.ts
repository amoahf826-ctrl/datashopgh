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

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in to continue." });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  const appBase = Deno.env.get("APP_BASE_URL")?.trim().replace(/\/+$/, "");
  if (!supabaseUrl || !anonKey || !serviceKey || !paystackSecret?.startsWith("sk_live_") || !appBase) {
    return json(503, { error: "Live checkout is not fully configured on the server." });
  }

  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user?.email) return json(401, { error: "A valid signed-in account with an email is required." });

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
    return json(400, { error: "Choose a valid live bundle and enter a valid Ghana phone number." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: setting, error: settingError } = await service.from("platform_settings")
    .select("value").eq("key", "storefront_live_sales").maybeSingle();
  if (settingError || setting?.value?.enabled !== true) return json(503, { error: "Live checkout is not enabled yet." });

  const orderId = crypto.randomUUID();
  const paystackReference = `DSGH-${crypto.randomUUID().replaceAll("-", "")}`;
  const deliveryReference = `DS${orderId.replaceAll("-", "").slice(0, 23)}`;
  const { data: order, error: orderError } = await service.rpc("create_live_checkout_order", {
    p_user_id: authData.user.id,
    p_bundle_id: body.bundle_id,
    p_recipient_phone: body.recipient_phone,
    p_idempotency_key: body.idempotency_key,
    p_payment_reference: paystackReference,
    p_delivery_reference: deliveryReference,
    p_agent_referral_code: typeof body.agent_referral_code === "string" ? body.agent_referral_code : null,
  });
  if (orderError || !order) return json(400, { error: orderError?.message ?? "Could not create the order." });
  if (order.checkout_url) return json(200, { authorization_url: order.checkout_url, reference: order.payment_reference });

  const callback = new URL(base.origin);
  callback.searchParams.set("payment", "complete");
  callback.searchParams.set("reference", order.payment_reference);
  const amount = Math.round(Number(order.price) * 100);
  if (!Number.isSafeInteger(amount) || amount < 100) return json(400, { error: "Bundle price is invalid for checkout." });

  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: authData.user.email, amount, currency: "GHS", reference: order.payment_reference,
        callback_url: callback.toString(), metadata: { order_id: order.id, delivery_reference: deliveryReference } }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.status !== true || typeof result?.data?.authorization_url !== "string") {
      return json(502, { error: "Paystack could not start checkout. No payment was taken." });
    }
    const { error: saveError } = await service.rpc("save_live_checkout_url", {
      p_order_id: order.id, p_url: result.data.authorization_url,
    });
    if (saveError) return json(502, { error: "Checkout started but could not be saved. Contact support before retrying." });
    return json(200, { authorization_url: result.data.authorization_url, reference: order.payment_reference });
  } catch {
    return json(502, { error: "Could not reach Paystack. No payment was taken." });
  }
});
