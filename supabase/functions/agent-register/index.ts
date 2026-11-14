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
function normalizePhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.startsWith("233") ? `0${digits.slice(3)}` : digits;
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
  if (password.length < 8 || password.length > 128) return json(400, { error: "Your password must have 8 to 128 characters." });
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

  // Admin removal preserves the auth identity and its financial history. Let
  // that same owner restore the account by proving the existing password.
  const { data: priorProfile, error: profileLookupError } = await service.from("profiles")
    .select("id,phone").eq("email", email).maybeSingle();
  if (profileLookupError) return json(503, { error: "Could not check your previous account. Please try again." });
  if (priorProfile) {
    const { data: priorAgent, error: agentLookupError } = await service.from("agent_accounts")
      .select("user_id,phone,deleted_at").eq("user_id", priorProfile.id).maybeSingle();
    if (agentLookupError) return json(503, { error: "Could not check your previous agent account. Please try again." });
    if (priorAgent?.deleted_at && normalizePhone(priorProfile.phone || priorAgent.phone) === phone) {
      const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
      if (signInError || !signedIn.session) {
        return json(401, { error: "This account was previously removed. Enter its existing password or reset that password to register again." });
      }
      const username = email.split("@")[0].toLowerCase().slice(0, 64) || "agent";
      const { error: restoreError } = await service.from("agent_accounts").update({
        is_active: true, deleted_at: null, agent_type: "agent", api_access_enabled: false,
        overdraft_enabled: false, username, business_name: fullName, phone,
      }).eq("user_id", priorProfile.id).not("deleted_at", "is", null);
      if (restoreError) return json(503, { error: "Your account was verified, but restoration failed. Please contact the administrator." });
      const { error: profileUpdateError } = await service.from("profiles").update({ full_name: fullName, phone }).eq("id", priorProfile.id);
      if (profileUpdateError) return json(503, { error: "Your agent access was restored, but profile details could not be updated. Please contact support." });
      await service.auth.admin.updateUserById(priorProfile.id, {
        user_metadata: { full_name: fullName, phone, account_type: "agent" },
      });
      return json(200, { success: true, session: signedIn.session, restored: true });
    }
  }

  const { data: phoneInUse, error: phoneError } = await service.rpc("is_profile_phone_in_use", { p_phone: phone });
  if (phoneError) return json(503, { error: "Could not check whether this phone number is already registered." });
  if (phoneInUse === true) return json(409, { error: "This phone number is already linked to an account. Use another number or sign in to that account." });

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: fullName, phone, account_type: "agent" },
  });
  if (createError || !created.user) {
    if (/phone|profiles_phone_unique_normalized|duplicate key/i.test(createError?.message ?? "")) {
      return json(409, { error: "This phone number is already linked to an account. Use another number or sign in to that account." });
    }
    return json(400, { error: createError?.message ?? "Agent registration could not be completed." });
  }

  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !signedIn.session) {
    return json(503, { error: "Your agent account was created, but automatic sign-in failed. Please sign in with your email and password." });
  }
  return json(200, { success: true, session: signedIn.session });
});
