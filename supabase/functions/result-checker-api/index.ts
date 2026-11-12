import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { purchaseDataHubVouchers } from "../_shared/datahub-vouchers.ts";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (status: number, data: Record<string, unknown>) => new Response(JSON.stringify(data), { status, headers });
function key(legacy: string, collection: string): string | undefined {
  const direct = Deno.env.get(legacy)?.trim(); if (direct) return direct;
  try { const values = JSON.parse(Deno.env.get(collection) ?? "{}"); if (typeof values.default === "string") return values.default; const first = Object.values(values).find(value => typeof value === "string"); return typeof first === "string" ? first : undefined; } catch { return undefined; }
}
function providerKey(): string | undefined { return Deno.env.get("DATAHUB_API_KEY")?.trim(); }
function readPrices(value: any) {
  return { enabled: value?.enabled === true,
    prices: { BECE: Number(value?.prices?.BECE ?? 0), WASSCE: Number(value?.prices?.WASSCE ?? 0) },
    agent_prices: { BECE: Number(value?.agent_prices?.BECE ?? 0), WASSCE: Number(value?.agent_prices?.WASSCE ?? 0) } };
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = key("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = key("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(503, { error: "Result checker service is not configured." });
  let body: any;
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const authorization = request.headers.get("Authorization");
  let signedInUser: { id: string; email?: string } | null = null;
  if (authorization?.startsWith("Bearer ")) {
    const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data } = await auth.auth.getUser();
    if (data.user) signedInUser = { id: data.user.id, email: data.user.email ?? undefined };
  }
  const { data: setting, error: settingError } = await service.from("platform_settings").select("value").eq("key", "result_checker_pricing").maybeSingle();
  if (settingError) return json(503, { error: "Could not load result checker settings." });
  const pricing = readPrices(setting?.value);
  if (body.action === "catalog") {
    const { data: feeSetting } = await service.from("platform_settings").select("value").eq("key", "paystack_fee_recovery").maybeSingle();
    let agentPrices: typeof pricing.agent_prices | undefined;
    let storePrices: typeof pricing.prices | undefined;
    if (signedInUser) {
      const { data: agent } = await service.from("agent_accounts").select("user_id").eq("user_id", signedInUser.id).eq("is_active", true).maybeSingle();
      if (agent) {
        agentPrices = pricing.agent_prices;
        const { data: overrides } = await service.from("agent_result_checker_prices").select("voucher_type,customer_price").eq("agent_id", signedInUser.id);
        storePrices = { ...pricing.prices };
        for (const row of overrides ?? []) if (row.voucher_type === "BECE" || row.voucher_type === "WASSCE") storePrices[row.voucher_type] = Number(row.customer_price);
      }
    }
    let storefrontPrices = pricing.prices;
    const referralCode = typeof body.agent_referral_code === "string" ? body.agent_referral_code.trim().toUpperCase() : "";
    if (referralCode) {
      const { data: referredAgent } = await service.from("agent_accounts").select("user_id").eq("referral_code", referralCode).eq("is_active", true).maybeSingle();
      if (!referredAgent) return json(400, { error: "This agent store link is no longer active." });
      const { data: overrides } = await service.from("agent_result_checker_prices").select("voucher_type,customer_price").eq("agent_id", referredAgent.user_id);
      storefrontPrices = { ...pricing.prices };
      for (const row of overrides ?? []) if (row.voucher_type === "BECE" || row.voucher_type === "WASSCE") storefrontPrices[row.voucher_type] = Number(row.customer_price);
    }
    return json(200, { enabled: pricing.enabled, prices: storefrontPrices, ...(agentPrices ? { agent_prices: agentPrices, store_prices: storePrices } : {}),
      fee_enabled: feeSetting?.value?.enabled !== false, fee_rate: Number(feeSetting?.value?.rate_percent ?? 3), provider_configured: !!providerKey() });
  }

  if (body.action === "save_store_prices") {
    if (!signedInUser) return json(401, { error: "Sign in to save your agent storefront prices." });
    const { data: agent } = await service.from("agent_accounts").select("user_id").eq("user_id", signedInUser.id).eq("is_active", true).maybeSingle();
    if (!agent) return json(403, { error: "An active agent account is required to set storefront prices." });
    const values = body.prices;
    if (!values || !["BECE", "WASSCE"].every(type => Number.isFinite(Number(values[type])) && Number(values[type]) > 0 && Number(values[type]) <= 10000)) {
      return json(400, { error: "Enter a valid positive price for both BECE and WASSCE." });
    }
    for (const type of ["BECE", "WASSCE"] as const) {
      if (Number(values[type]) < pricing.agent_prices[type]) return json(400, { error: `Your ${type} storefront price must be at least ${pricing.agent_prices[type].toFixed(2)} GHS.` });
    }
    const { error } = await service.from("agent_result_checker_prices").upsert([
      { agent_id: signedInUser.id, voucher_type: "BECE", customer_price: Number(values.BECE).toFixed(2), updated_at: new Date().toISOString() },
      { agent_id: signedInUser.id, voucher_type: "WASSCE", customer_price: Number(values.WASSCE).toFixed(2), updated_at: new Date().toISOString() },
    ], { onConflict: "agent_id,voucher_type" });
    if (error) {
      console.error("Agent result checker price upsert failed.", error.code ?? "unknown");
      if (error.code === "42P01" || error.code === "PGRST205") {
        return json(503, { error: "Agent storefront price storage is missing. Apply migration 202611120003_agent_result_checker_prices.sql, then retry." });
      }
      return json(503, { error: `Could not save your result checker storefront prices (${error.code ?? "database error"}).` });
    }
    return json(200, { success: true, store_prices: { BECE: Number(values.BECE), WASSCE: Number(values.WASSCE) } });
  }

  const voucherType = typeof body.voucher_type === "string" ? body.voucher_type.toUpperCase() : "";
  const phone = typeof body.recipient_phone === "string" ? body.recipient_phone.trim() : "";
  const quantity = Number(body.quantity);
  if (!pricing.enabled || !["BECE", "WASSCE"].includes(voucherType)) return json(400, { error: "Choose an available BECE or WASSCE checker." });
  if (!/^0\d{9}$/.test(phone) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return json(400, { error: "Enter a valid Ghana phone number and quantity from 1 to 100." });

  const datahubKey = providerKey();
  if (!datahubKey) return json(503, { error: "DataHub API key is not configured in Supabase Edge Function secrets." });

  if (body.action === "wallet_purchase") {
    if (!signedInUser) return json(401, { error: "Sign in to use your agent wallet." });
    const reference = `RCW-${crypto.randomUUID().replaceAll("-", "")}`;
    const created = await service.rpc("create_result_checker_wallet_order", { p_user_id: signedInUser.id, p_voucher_type: voucherType, p_phone: phone, p_quantity: quantity, p_reference: reference });
    if (created.error) return json(400, { error: created.error.message });
    const orderId = String(created.data?.order_id ?? "");
    const origin = Deno.env.get("APP_BASE_URL")?.trim().replace(/\/$/, "");
    const purchased = await purchaseDataHubVouchers(datahubKey, voucherType as "BECE" | "WASSCE", phone, quantity, origin);
    const finished = await service.rpc("finish_result_checker_order", {
      p_order_id: orderId, p_status: purchased.ok ? "completed" : purchased.definite ? "failed" : "needs_review",
      p_vouchers: purchased.ok ? purchased.result.vouchers : [], p_transactions: purchased.ok ? purchased.result.transactions : [],
      p_message: purchased.ok ? purchased.result.message : purchased.message,
    });
    if (finished.error) return json(503, { error: "The provider response was received, but could not be saved. Contact support before retrying.", order_id: orderId });
    if (!purchased.ok) return json(purchased.definite ? 400 : 202, { error: purchased.message, order_id: orderId, status: purchased.definite ? "failed" : "needs_review", wallet_balance: finished.data?.wallet_balance });
    return json(200, { success: true, order_id: orderId, wallet_balance: created.data.wallet_balance, vouchers: purchased.result.vouchers, message: purchased.result.message });
  }

  if (body.action === "paystack_checkout") {
    const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
    const appBase = Deno.env.get("APP_BASE_URL")?.trim();
    if (!paystackSecret?.startsWith("sk_live_") || !appBase) return json(503, { error: "Paystack checkout is not configured." });
    let base: URL;
    try { base = new URL(appBase); if (base.protocol !== "https:" || base.pathname !== "/") throw new Error(); }
    catch { return json(503, { error: "APP_BASE_URL must be a secure site origin." }); }
    let referredBy: string | null = null;
    let unitPrice = pricing.prices[voucherType as "BECE" | "WASSCE"];
    let agentCost = 0;
    if (typeof body.agent_referral_code === "string" && body.agent_referral_code.trim()) {
      const referralCode = body.agent_referral_code.trim().toUpperCase();
      const { data: agent } = await service.from("agent_accounts").select("user_id").eq("referral_code", referralCode).eq("is_active", true).maybeSingle();
      if (!agent) return json(400, { error: "This agent store link is no longer active." });
      referredBy = agent.user_id;
      agentCost = pricing.agent_prices[voucherType as "BECE" | "WASSCE"];
      const { data: customPrice } = await service.from("agent_result_checker_prices").select("customer_price").eq("agent_id", referredBy).eq("voucher_type", voucherType).maybeSingle();
      if (customPrice) unitPrice = Number(customPrice.customer_price);
    }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return json(400, { error: "This checker does not have a valid customer price yet." });
    const total = Math.round(unitPrice * quantity * 100) / 100;
    const { data: feeSetting } = await service.from("platform_settings").select("value").eq("key", "paystack_fee_recovery").maybeSingle();
    const rate = feeSetting?.value?.enabled === true ? Number(feeSetting.value?.rate_percent ?? 3) : 0;
    if (!Number.isFinite(rate) || rate < 0 || rate > 10) return json(503, { error: "The Paystack fee setting is invalid." });
    const fee = Math.round(total * 100 * rate / 100) / 100;
    const charge = total + fee;
    if (charge <= 0 || charge > 10000) return json(400, { error: "The checker purchase exceeds the maximum checkout amount." });
    const paystackReference = `RCHK-${crypto.randomUUID().replaceAll("-", "")}`;
    const { data: created, error: insertError } = await service.from("result_checker_orders").insert({
      user_id: signedInUser?.id ?? null, referred_by_agent_id: referredBy, voucher_type: voucherType, recipient_phone: phone,
      quantity, unit_price: unitPrice, total_amount: total, fee_amount: fee, charge_amount: charge,
      agent_cost: agentCost, agent_profit_amount: referredBy ? Math.max(0, unitPrice - agentCost) * quantity : 0,
      payment_method: "paystack", payment_reference: paystackReference, payment_status: "unpaid", status: "pending_payment",
    }).select("id").single();
    if (insertError || !created) return json(503, { error: "Could not create a checker checkout. No payment was taken." });
    const callback = new URL(base.origin); callback.searchParams.set("checker_payment", "complete"); callback.searchParams.set("reference", paystackReference);
    try {
      const response = await fetch("https://api.paystack.co/transaction/initialize", { method: "POST",
        headers: { Authorization: `Bearer ${paystackSecret}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: signedInUser?.email ?? `guest-${created.id}@checkout.cheapdatabundle.com`, amount: Math.round(charge * 100), currency: "GHS", reference: paystackReference, callback_url: callback.toString(), metadata: { result_checker_order_id: created.id, voucher_type: voucherType, quantity, fee_amount: fee } }),
        signal: AbortSignal.timeout(20000) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.status !== true || typeof payload?.data?.authorization_url !== "string") {
        await service.from("result_checker_orders").update({ status: "failed", payment_status: "failed", provider_message: "Paystack could not initialize checkout." }).eq("id", created.id);
        return json(502, { error: "Paystack could not start checkout. No payment was taken." });
      }
      return json(200, { authorization_url: payload.data.authorization_url, reference: paystackReference, total_amount: total, fee_amount: fee, charge_amount: charge });
    } catch {
      await service.from("result_checker_orders").update({ status: "failed", payment_status: "failed", provider_message: "Paystack checkout could not be reached." }).eq("id", created.id);
      return json(502, { error: "Could not reach Paystack. No payment was taken." });
    }
  }

  if (body.action === "receipt") {
    const reference = typeof body.reference === "string" ? body.reference.trim() : "";
    if (!/^RCHK-[A-Fa-f0-9]{32}$/.test(reference)) return json(400, { error: "Enter a valid receipt reference." });
    const query = service.from("result_checker_orders").select("id,user_id,voucher_type,recipient_phone,quantity,total_amount,charge_amount,payment_method,payment_status,status,vouchers,provider_message,created_at").eq("payment_reference", reference);
    const { data: order } = await query.maybeSingle();
    if (!order) return json(404, { error: "Checker purchase was not found." });
    const isOwner = !!signedInUser && order.user_id === signedInUser.id;
    const isAdmin = signedInUser ? (await service.from("profiles").select("role").eq("id", signedInUser.id).maybeSingle()).data?.role === "admin" : false;
    if (!isOwner && !isAdmin && body.recipient_phone !== order.recipient_phone) return json(404, { error: "Checker purchase was not found." });
    return json(200, { order });
  }
  return json(400, { error: "Choose a supported result checker action." });
});
