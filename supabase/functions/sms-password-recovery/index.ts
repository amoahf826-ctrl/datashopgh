import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: cors });
const genericMessage = "If an account matches those details, a recovery code will be sent to its verified phone or email.";

function toHex(bytes: Uint8Array) { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}
function providerCode(body: string): string {
  try { const value = JSON.parse(body); return String(value?.code ?? value?.status_code ?? value?.status ?? "").trim(); }
  catch { return body.trim().replace(/^"|"$/g, ""); }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !anon || !serviceKey) return json(503, { error: "Password recovery is temporarily unavailable." });
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: { operation?: string; email?: string; phone?: string; challenge_id?: string; code?: string; password?: string; redirect_to?: string };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }

  if (body.operation === "request") {
    const emailInput = String(body.email ?? "").trim().toLowerCase();
    const phoneInput = String(body.phone ?? "").replace(/\D/g, "");
    const recoveryPhone = phoneInput.startsWith("233") && phoneInput.length === 12 ? `0${phoneInput.slice(3)}` : phoneInput;
    const byPhone = /^0\d{9}$/.test(recoveryPhone);
    if (!byPhone && !/^\S+@\S+\.\S+$/.test(emailInput)) return json(400, { error: "Enter the account email address or verified Ghana phone number." });
    const challengeId = String(body.challenge_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(challengeId)) return json(400, { error: "Could not start password recovery. Please try again." });
    const appOrigin = (Deno.env.get("APP_BASE_URL") || request.headers.get("origin") || "https://cheapdatabundle.com").replace(/\/+$/, "");
    const redirectTo = `${appOrigin}/`;

    const { data: profile } = byPhone
      ? await service.from("profiles").select("id,email,phone").eq("phone", recoveryPhone).limit(1).maybeSingle()
      : await service.from("profiles").select("id,email,phone").eq("email", emailInput).limit(1).maybeSingle();
    const email = String(profile?.email ?? (!byPhone ? emailInput : "")).trim().toLowerCase();
    let verifiedPhone = "";
    if (profile?.id) {
      const { data: result } = await service.auth.admin.getUserById(profile.id);
      const authUser = result?.user;
      if (authUser?.phone && authUser.phone_confirmed_at) {
        const digits = authUser.phone.replace(/\D/g, "");
        verifiedPhone = digits.startsWith("233") && digits.length === 12 ? `0${digits.slice(3)}` : digits;
        if (!/^0\d{9}$/.test(verifiedPhone)) verifiedPhone = "";
      }
    }

    const smsKey = Deno.env.get("SMSNOTIFYGH_API_KEY")?.trim();
    const otpSecret = Deno.env.get("SMS_PASSWORD_RESET_SECRET")?.trim() || serviceKey;
    let shouldUseEmail = !verifiedPhone || !smsKey || !otpSecret;
    if (verifiedPhone && smsKey && otpSecret && profile?.id) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
      const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const [codeHash, ipHash] = await Promise.all([hmac(otpSecret, `${challengeId}:${code}`), hmac(otpSecret, `ip:${ip}`)]);
      const { data: allowed, error: issueError } = await service.rpc("issue_sms_password_recovery_challenge", {
        p_challenge_id: challengeId, p_user_id: profile.id, p_code_hash: codeHash, p_ip_hash: ipHash,
      });
      if (issueError || allowed !== true) shouldUseEmail = true;
      if (!issueError && allowed === true) {
        const { data: settings } = await service.from("sms_provider_settings").select("sender_id").eq("id", true).maybeSingle();
        const sender = String(settings?.sender_id ?? "").trim();
        if (sender && sender.length <= 11) {
          const params = new URLSearchParams({ key: smsKey, to: verifiedPhone, msg: `CheapDataBundle password reset code: ${code}. Expires in 10 minutes. If you did not request this, ignore this message.`, sender_id: sender });
          try {
            const response = await fetch(`https://sms.smsnotifygh.com/smsapi?${params.toString()}`, {
              method: "GET", headers: { Accept: "application/json, text/plain" }, signal: AbortSignal.timeout(12000),
            });
            const accepted = response.ok && providerCode(await response.text()) === "1000";
            if (accepted) shouldUseEmail = false;
          } catch { /* Fall through to the email recovery route. */ }
        }
        if (shouldUseEmail) await service.from("sms_password_recovery_challenges").update({ consumed_at: new Date().toISOString() }).eq("challenge_id", challengeId);
      }
    }

    if (shouldUseEmail && email) {
      const auth = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
      await auth.auth.resetPasswordForEmail(email, { redirectTo });
    }
    return json(200, { success: true, message: genericMessage });
  }

  const challengeId = String(body.challenge_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(challengeId)) return json(400, { error: "The code is invalid or expired. Request a new one." });
  if (body.operation === "verify") {
    const code = String(body.code ?? "");
    const secret = Deno.env.get("SMS_PASSWORD_RESET_SECRET")?.trim() || serviceKey;
    if (!secret || !/^\d{6}$/.test(code)) return json(400, { error: "The code is invalid or expired. Request a new one." });
    const codeHash = await hmac(secret, `${challengeId}:${code}`);
    const { data, error } = await service.rpc("verify_sms_password_recovery_challenge", { p_challenge_id: challengeId, p_code_hash: codeHash });
    if (error || data !== true) return json(400, { error: "The code is invalid or expired. Check your email if your account does not have a verified phone." });
    return json(200, { success: true, verified: true });
  }

  if (body.operation === "set-password") {
    const password = String(body.password ?? "");
    if (password.length < 8 || password.length > 128) return json(400, { error: "Use a password between 8 and 128 characters." });
    const { data: userId, error: consumeError } = await service.rpc("consume_sms_password_recovery_challenge", { p_challenge_id: challengeId });
    if (consumeError || typeof userId !== "string") return json(400, { error: "The recovery session expired. Request a new code." });
    const { error } = await service.auth.admin.updateUserById(userId, { password });
    if (error) return json(500, { error: "Could not update the password. Request a new recovery code and try again." });
    return json(200, { success: true });
  }
  return json(400, { error: "Unknown password recovery operation." });
});
