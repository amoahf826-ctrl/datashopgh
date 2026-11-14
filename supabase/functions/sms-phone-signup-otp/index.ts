import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });
function key(legacyName: string, collectionName: string): string | undefined {
  const legacy = Deno.env.get(legacyName)?.trim();
  if (legacy) return legacy;
  try {
    const values = JSON.parse(Deno.env.get(collectionName) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}
function hex(bytes: Uint8Array) { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
async function hmac(secret: string, value: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value))));
}
function providerCode(value: string) {
  try { const parsed = JSON.parse(value); return String(parsed?.code ?? parsed?.status_code ?? parsed?.status ?? "").trim(); }
  catch { return value.trim().replace(/^"|"$/g, ""); }
}
function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return `0${digits.slice(3)}`;
  return digits;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const url = Deno.env.get("SUPABASE_URL");
  const anon = key("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = key("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !anon || !serviceKey) return json(503, { error: "Phone verification is temporarily unavailable." });
  if (request.headers.get("apikey") !== anon) return json(401, { error: "Invalid request." });
  const smsKey = Deno.env.get("SMSNOTIFYGH_API_KEY")?.trim();
  const secret = Deno.env.get("SMS_PASSWORD_RESET_SECRET")?.trim() || serviceKey;
  if (!smsKey || !secret) return json(503, { error: "SMS verification is not configured. Contact support." });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (body.operation === "request") {
    const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : "";
    const challengeId = String(body.challenge_id ?? "");
    if (!/^0\d{9}$/.test(phone) || !/^[0-9a-f-]{36}$/i.test(challengeId)) {
      return json(400, { error: "Enter a valid Ghana phone number." });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || name.length > 100 || password.length < 8 || password.length > 128) {
      return json(400, { error: "Enter a valid email, name, and password of at least 8 characters." });
    }
    const { data: existingPhone, error: phoneError } = await service.from("profiles").select("id").eq("phone", phone).limit(1).maybeSingle();
    if (phoneError) return json(503, { error: "Could not check account details. Please try again." });
    if (existingPhone) return json(409, { error: "This phone number is already registered. Log in or use Forgot password." });
    const { data: existingEmail, error: emailError } = await service.from("profiles").select("id").ilike("email", email).limit(1).maybeSingle();
    if (emailError) return json(503, { error: "Could not check account details. Please try again." });
    if (existingEmail) return json(409, { error: "This email is already registered. Log in or use Forgot password." });

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const [codeHash, ipHash] = await Promise.all([hmac(secret, `${challengeId}:${code}`), hmac(secret, `ip:${ip}`)]);
    const { data: allowed, error: issueError } = await service.rpc("issue_sms_phone_signup_challenge", {
      p_challenge_id: challengeId, p_phone: phone, p_code_hash: codeHash, p_ip_hash: ipHash,
    });
    if (issueError) return json(503, { error: "Could not send a verification code. Please try again." });
    if (allowed !== true) return json(429, { error: "Too many verification requests. Please wait and try again." });

    const { data: settings, error: settingsError } = await service.from("sms_provider_settings").select("sender_id").eq("id", true).maybeSingle();
    const sender = String(settings?.sender_id ?? "").trim();
    if (settingsError || !sender || sender.length > 11) {
      await service.from("sms_phone_signup_challenges").update({ consumed_at: new Date().toISOString() }).eq("challenge_id", challengeId);
      return json(503, { error: "SMS sender ID is not configured. Contact support." });
    }
    const params = new URLSearchParams({ key: smsKey, to: phone, msg: `CheapDataBundle account verification code: ${code}. Expires in 10 minutes. Do not share this code.`, sender_id: sender });
    try {
      const response = await fetch(`https://sms.smsnotifygh.com/smsapi?${params.toString()}`, {
        method: "GET", headers: { Accept: "application/json, text/plain" }, signal: AbortSignal.timeout(12000),
      });
      if (!response.ok || providerCode(await response.text()) !== "1000") {
        await service.from("sms_phone_signup_challenges").update({ consumed_at: new Date().toISOString() }).eq("challenge_id", challengeId);
        return json(502, { error: "SMS provider could not send the code. Please try again later." });
      }
    } catch {
      await service.from("sms_phone_signup_challenges").update({ consumed_at: new Date().toISOString() }).eq("challenge_id", challengeId);
      return json(502, { error: "SMS provider could not send the code. Please try again later." });
    }
    return json(200, { success: true, challenge_id: challengeId, message: "Verification code sent. It expires in 10 minutes." });
  }

  if (body.operation === "complete") {
    const challengeId = String(body.challenge_id ?? "");
    const code = String(body.code ?? "");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : "";
    if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code) || !/^\S+@\S+\.\S+$/.test(email) ||
        name.length < 2 || name.length > 100 || password.length < 8 || password.length > 128 || !/^0\d{9}$/.test(phone)) {
      return json(400, { error: "Check the code and your account details, then try again." });
    }
    const [codeHash, phoneChallenge] = await Promise.all([
      hmac(secret, `${challengeId}:${code}`),
      service.from("sms_phone_signup_challenges").select("phone").eq("challenge_id", challengeId).maybeSingle(),
    ]);
    if (phoneChallenge.error || phoneChallenge.data?.phone !== phone) return json(400, { error: "The code is invalid or expired. Request a new one." });
    const { data: verified, error: verifyError } = await service.rpc("verify_sms_phone_signup_challenge", { p_challenge_id: challengeId, p_code_hash: codeHash });
    if (verifyError || verified !== true) return json(400, { error: "The code is invalid or expired. Check it and try again." });
    const { data: consumedPhone, error: consumeError } = await service.rpc("consume_sms_phone_signup_challenge", { p_challenge_id: challengeId });
    if (consumeError || consumedPhone !== phone) return json(400, { error: "The code has expired. Request a new one." });

    const metadata: Record<string, string> = { full_name: name, phone };
    if (body.agent_signup === true) metadata.account_type = "agent";
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email, password, email_confirm: true, phone: `+233${phone.slice(1)}`, phone_confirm: true, user_metadata: metadata,
    });
    if (createError || !created.user) {
      return json(409, { error: "Could not create this account. Check that the email and phone are not already registered." });
    }
    const { error: profileError } = await service.from("profiles").update({ phone }).eq("id", created.user.id);
    if (profileError) {
      await service.auth.admin.deleteUser(created.user.id);
      return json(500, { error: "Account setup did not finish. Please retry registration." });
    }
    return json(200, { success: true, email, message: "Phone verified. Your account is ready." });
  }
  return json(400, { error: "Unknown verification operation." });
});
