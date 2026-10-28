import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

function readSupabaseKey(legacyName: string, collectionName: string): string | undefined {
  const legacy = Deno.env.get(legacyName)?.trim();
  if (legacy) return legacy;
  try {
    const values = JSON.parse(Deno.env.get(collectionName) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in to continue." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readSupabaseKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  const appBase = Deno.env.get("APP_BASE_URL")?.trim().replace(/\/+$/, "");
  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!anonKey) missing.push("Supabase publishable/anon key");
  if (!serviceKey) missing.push("Supabase secret/service-role key");
  if (!secret?.startsWith("sk_live_")) missing.push("PAYSTACK_SECRET_KEY (must be a live key)");
  if (!appBase) missing.push("APP_BASE_URL");
  if (missing.length) {
    return json(503, { error: `Live wallet deposits are not fully configured: ${missing.join(", ")}.` });
  }

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user?.email) return json(401, { error: "A valid signed-in account with an email is required." });

  let base: URL;
  try { base = new URL(appBase); } catch { return json(503, { error: "APP_BASE_URL must be a valid HTTPS URL." }); }
  if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash) {
    return json(503, { error: "APP_BASE_URL must be a secure site origin." });
  }

  let body: { amount?: unknown; idempotency_key?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || Math.round(amount * 100) !== amount * 100 || amount < 1 || amount > 10000 ||
      typeof body.idempotency_key !== "string" || !/^[0-9a-f-]{36}$/i.test(body.idempotency_key)) {
    return json(400, { error: "Enter a deposit amount from GHS 1.00 to GHS 10,000.00." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: setting, error: settingError } = await service.from("platform_settings")
    .select("value").eq("key", "wallet_deposits_enabled").maybeSingle();
  if (settingError || setting?.value?.enabled !== true) return json(503, { error: "Wallet deposits are currently unavailable." });

  const reference = `DSGW-${crypto.randomUUID().replaceAll("-", "")}`;
  const { data: deposit, error: depositError } = await service.rpc("create_paystack_wallet_deposit", {
    p_user_id: authData.user.id, p_amount: amount, p_idempotency_key: body.idempotency_key, p_reference: reference,
  });
  if (depositError || !deposit) return json(400, { error: depositError?.message ?? "Could not create the wallet deposit." });
  if (deposit.status !== "pending") return json(409, { error: "This wallet deposit is no longer pending. Start a new top-up." });
  if (deposit.checkout_url) return json(200, { authorization_url: deposit.checkout_url, reference: deposit.reference });

  const callback = new URL(base.origin);
  callback.searchParams.set("wallet_deposit", "complete");
  callback.searchParams.set("reference", deposit.reference);
  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email: authData.user.email, amount: Math.round(Number(deposit.amount) * 100), currency: "GHS",
        reference: deposit.reference, callback_url: callback.toString(),
        metadata: { kind: "wallet_deposit", deposit_id: deposit.id, user_id: authData.user.id },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.status !== true || typeof result?.data?.authorization_url !== "string") {
      return json(502, { error: "Paystack could not start the wallet top-up. No payment was taken." });
    }
    const { error: saveError } = await service.rpc("save_wallet_deposit_checkout_url", {
      p_deposit_id: deposit.id, p_url: result.data.authorization_url,
    });
    if (saveError) return json(502, { error: "Checkout could not be safely saved. No payment was taken; retry shortly." });
    return json(200, { authorization_url: result.data.authorization_url, reference: deposit.reference });
  } catch {
    return json(502, { error: "Could not reach Paystack. No payment was taken." });
  }
});
