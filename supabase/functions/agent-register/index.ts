import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });
function readKey(legacyName: string, collectionName: string): string | undefined {
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(503, { error: "Agent registration is not configured." });
  if (request.headers.get("apikey") !== anonKey) return json(401, { error: "Invalid request." });

  let body: { email?: unknown; password?: unknown; full_name?: unknown; phone?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const rawPhone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
  const phone = rawPhone.startsWith("233") ? `0${rawPhone.slice(3)}` : rawPhone;
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return json(400, { error: "Enter a valid email address." });
  if (password.length < 6 || password.length > 128) return json(400, { error: "Your password must have 6 to 128 characters." });
  if (fullName.length < 2 || fullName.length > 120) return json(400, { error: "Enter your full name." });
  if (!/^0\d{9}$/.test(phone)) return json(400, { error: "Enter a valid Ghana phone number, such as 0241234567." });

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const rateKey = `agent-signup:${Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  const { data: allowed, error: rateError } = await service.rpc("consume_agent_signup_rate_limit", { p_rate_key: rateKey });
  if (rateError) return json(503, { error: "Agent registration is temporarily unavailable. Apply the agent signup migration and try again." });
  if (allowed !== true) return json(429, { error: "Too many registration attempts. Please wait and try again." });

  // Deleted accounts must be permanently removed by an administrator before
  // their email and phone can be registered again. Never restore a soft-deleted
  // account from this public signup endpoint.
  const { data: phoneInUse, error: phoneError } = await service.rpc("is_profile_phone_in_use", { p_phone: phone });
  if (phoneError) return json(503, { error: "Could not check whether this phone number is already registered." });
  if (phoneInUse === true) return json(409, { error: "This phone number is already linked to an account. Use another number or sign in to that account." });

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: fullName, phone, account_type: "agent" },
  });
  if (createError || !created.user) {
    if (/phone|profiles_phone_unique_normalized/i.test(createError?.message ?? "")) {
      return json(409, { error: "This phone number is already linked to an account. Use another number or sign in to that account." });
    }
    if (/email.*already|already.*email|user already registered|already registered|duplicate key/i.test(createError?.message ?? "")) {
      return json(409, { error: "This email is still linked to an account. Sign in, or ask the administrator to permanently delete the previous account before registering again." });
    }
    return json(400, { error: createError?.message ?? "Agent registration could not be completed." });
  }

  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !signedIn.session) {
    return json(503, { error: "Your agent account was created, but automatic sign-in failed. Please sign in with your email and password." });
  }
  return json(200, { success: true, session: signedIn.session });
});
