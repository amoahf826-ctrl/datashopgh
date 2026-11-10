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
  let body: { phone?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!/^0\d{9}$/.test(phone)) return json(400, { error: "Enter a valid 10-digit Ghana phone number." });

  const rawIp = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0];
  const clientIp = rawIp?.trim() ?? "";
  if (clientIp.length < 3 || clientIp.length > 64) return json(503, { error: "Order tracking is temporarily unavailable." });
  const url = Deno.env.get("SUPABASE_URL");
  const key = serviceKey();
  if (!url || !key) return json(503, { error: "Order tracking is temporarily unavailable." });
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await service.rpc("public_track_orders_by_phone", { p_phone: phone, p_client_ip: clientIp });
  if (error) return json(500, { error: "Could not check your orders. Please try again." });
  if (data?.rate_limited) return json(429, { error: "Too many tracking searches. Please wait a few minutes and try again." });
  return json(200, { orders: Array.isArray(data?.orders) ? data.orders : [] });
});
