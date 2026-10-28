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
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in to verify the wallet deposit." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readSupabaseKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  if (!supabaseUrl || !anonKey || !serviceKey || !secret?.startsWith("sk_live_")) {
    return json(503, { error: "Live wallet verification is not configured on the server." });
  }

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session is invalid or expired." });
  let body: { reference?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (typeof body.reference !== "string" || !/^DSGW-[A-Fa-f0-9]{32}$/.test(body.reference)) {
    return json(400, { error: "A valid wallet payment reference is required." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: deposit, error: depositError } = await service.from("deposits")
    .select("id,user_id,amount,status,provider_reference,checkout_url")
    .eq("provider", "paystack").eq("provider_reference", body.reference).eq("user_id", authData.user.id).maybeSingle();
  if (depositError || !deposit) return json(404, { error: "This wallet deposit was not found for your account." });
  if (deposit.status === "successful") {
    const { data: wallet } = await service.from("wallets").select("balance").eq("user_id", authData.user.id).maybeSingle();
    return json(200, { success: true, credited: false, balance: Number(wallet?.balance ?? 0), message: "This payment was already credited." });
  }
  if (deposit.status !== "pending") return json(409, { error: "This wallet deposit is no longer pending." });

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(body.reference)}`, {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => null);
    const transaction = result?.data;
    if (!response.ok || result?.status !== true || transaction?.status !== "success" ||
        transaction?.reference !== body.reference || transaction?.currency !== "GHS" ||
        !Number.isSafeInteger(transaction?.amount) || transaction.amount !== Math.round(Number(deposit.amount) * 100)) {
      return json(200, { success: false, message: "Paystack has not confirmed this wallet payment yet." });
    }
    const { data: claim, error: claimError } = await service.rpc("claim_paystack_wallet_deposit", {
      p_reference: body.reference, p_amount: transaction.amount, p_currency: transaction.currency,
    });
    if (claimError || !claim) return json(500, { error: "Verified wallet payment could not be credited. Contact support with your reference." });
    return json(200, { success: true, credited: claim.credited, balance: Number(claim.balance ?? 0), message: "Wallet payment verified." });
  } catch {
    return json(502, { error: "Could not verify payment with Paystack. The webhook will retry if payment succeeded." });
  }
});
