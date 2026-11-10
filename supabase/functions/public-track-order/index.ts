import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

function serviceKey(): string | undefined {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;
  try {
    const values = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  let body: { phone?: unknown; reference?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const reference = typeof body.reference === "string" ? body.reference.trim().toUpperCase() : "";
  if (!/^0\d{9}$/.test(phone) || !/^DSGH-[0-9A-F]{32}$/.test(reference)) {
    return json(400, { error: "Enter the recipient phone number and the order reference from your Paystack receipt." });
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = serviceKey();
  if (!url || !key) return json(503, { error: "Order tracking is temporarily unavailable." });
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await service.from("orders")
    .select("id,recipient_phone,status,payment_status,delivery_status,price,created_at,bundles(size,network)")
    .eq("payment_reference", reference).eq("recipient_phone", phone).eq("is_demo", false).maybeSingle();
  if (error) return json(500, { error: "Could not check this order. Please try again." });
  if (!data) return json(200, { order: null });
  const row = data as any;
  return json(200, { order: {
    id: row.id,
    recipient_phone: row.recipient_phone,
    status: row.status,
    payment_status: row.payment_status,
    delivery_status: row.delivery_status,
    price: row.price,
    created_at: row.created_at,
    bundles: Array.isArray(row.bundles) ? row.bundles[0] ?? null : row.bundles ?? null,
  } });
});
