import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

function readServiceKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
    if (typeof keys.default === "string") return keys.default;
    const first = Object.values(keys).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

function readPublicKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}") as Record<string, unknown>;
    if (typeof keys.default === "string") return keys.default;
    const first = Object.values(keys).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

async function signPaystackEvent(raw: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const serviceKey = readServiceKey();
  const publicKey = readPublicKey();
  const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  if (!supabaseUrl || !serviceKey || !paystackSecret) return json(503, { error: "Payment reconciliation is not configured." });

  let body: { reference?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const reference = body.reference;
  if (typeof reference !== "string" || !/^DSGH-[a-f0-9]{32}$/i.test(reference)) {
    return json(400, { error: "A valid storefront payment reference is required." });
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: order, error: orderError } = await service.from("orders")
    .select("id,price,charge_amount,payment_status")
    .eq("payment_reference", reference).maybeSingle();
  if (orderError) return json(500, { error: "Could not load the storefront order." });
  if (!order) return json(404, { error: "No storefront order matches that payment reference." });
  if (order.payment_status === "successful") return json(200, { success: true, already_processed: true });

  try {
    const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${paystackSecret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const result = await verified.json().catch(() => null);
    const transaction = result?.data;
    if (!verified.ok || result?.status !== true || transaction?.status !== "success" ||
        transaction?.reference !== reference || transaction?.currency !== "GHS" ||
        Number(transaction?.amount) !== Math.round(Number(order.charge_amount ?? order.price) * 100)) {
      return json(200, { success: false, pending: true, message: "Paystack has not confirmed this payment yet. Your order will update when confirmation arrives." });
    }

    // Reuse the signed Paystack webhook pipeline so callback verification and
    // webhook delivery share the same idempotent payment claim and fulfillment.
    const event = JSON.stringify({ event: "charge.success", data: { reference } });
    const signature = await signPaystackEvent(event, paystackSecret);
    const headers = new Headers({ "Content-Type": "application/json", "x-paystack-signature": signature });
    if (publicKey) headers.set("apikey", publicKey);
    const webhook = await fetch(`${supabaseUrl}/functions/v1/paystack-webhook`, {
      method: "POST",
      headers,
      body: event,
      signal: AbortSignal.timeout(25000),
    });
    if (!webhook.ok) return json(502, { error: "Payment was verified, but the order service could not process it yet. The Paystack webhook will retry." });
    return json(200, { success: true, message: "Payment verified. Your order is being sent to the delivery provider." });
  } catch {
    return json(502, { error: "Could not verify or reconcile this payment right now. The Paystack webhook will retry." });
  }
});
