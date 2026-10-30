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
type Result = { number: string; status?: "verified"|"unverified"|"queued"|"invalid"; request_id?: string|null; error?: string };
function normalizedNumber(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9 && !digits.startsWith("0")) return `0${digits}`;
  return digits;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in is required." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const hubnetToken = Deno.env.get("HUBNET_BEARER_TOKEN")?.trim();
  const hubnetBase = Deno.env.get("HUBNET_API_BASE_URL")?.trim().replace(/\/+$/, "");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(503, { error: "Supabase function auth is not configured." });

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session is invalid or expired." });
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: agent, error: agentError } = await service.from("agent_accounts")
    .select("is_active").eq("user_id", authData.user.id).maybeSingle();
  if (agentError) return json(503, { error: "Could not verify agent access." });
  if (!agent?.is_active) return json(403, { error: "An active agent account is required." });
  if (!hubnetToken || !hubnetBase) return json(503, { error: "Hubnet server secrets are not configured." });

  let base: URL;
  try { base = new URL(hubnetBase); } catch { return json(503, { error: "HUBNET_API_BASE_URL must be a valid HTTPS URL." }); }
  if (base.protocol !== "https:" || base.hostname !== "console.hubnet.app" || base.username || base.password || base.search || base.hash) {
    return json(503, { error: "Hubnet API base must use the verified console.hubnet.app HTTPS origin." });
  }

  let body: { numbers?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (!Array.isArray(body.numbers) || body.numbers.length < 1 || body.numbers.length > 25 ||
      body.numbers.some((number) => typeof number !== "string" || !/^0\d{9}$/.test(number))) {
    return json(400, { error: "Submit 1 to 25 valid 10-digit Ghanaian MTN numbers per check." });
  }
  const numbers = [...new Set(body.numbers as string[])];
  const { data: submissions, error: submissionsError } = await service.from("agent_number_submissions")
    .select("phone_number").eq("agent_id", authData.user.id).in("phone_number", numbers);
  if (submissionsError) return json(503, { error: "Could not verify these submitted numbers." });
  const ownedNumbers = new Set((submissions ?? []).map((row) => row.phone_number));
  if (numbers.some((number) => !ownedNumbers.has(number))) return json(403, { error: "Submit these numbers through your agent account before checking them." });

  const tokenHeader = /^Bearer\s+/i.test(hubnetToken) ? hubnetToken : `Bearer ${hubnetToken}`;
  const results: Result[] = new Array(numbers.length);
  let next = 0;
  async function verifyWorker() {
    while (next < numbers.length) {
      const index = next++;
      const number = numbers[index];
      const endpoint = new URL(`${hubnetBase}/live/api/context/business/transaction/mtn-verification`);
      endpoint.searchParams.set("number", number);
      try {
        const response = await fetch(endpoint, {
          method: "GET", headers: { token: tokenHeader, Accept: "application/json" },
          signal: AbortSignal.timeout(12000),
        });
        const payload = await response.json().catch(() => null);
        const data = payload?.response?.data ?? payload?.data;
        const status = String(data?.status ?? "").toLowerCase();
        if (!response.ok || payload?.status !== true || !["verified","unverified","queued","invalid"].includes(status) ||
            (data?.number != null && normalizedNumber(data.number) !== number)) {
          results[index] = { number, error: payload?.message ?? payload?.response?.message ?? `Hubnet returned HTTP ${response.status}.` };
        } else {
          results[index] = { number, status: status as Result["status"], request_id: typeof payload.request_id === "string" ? payload.request_id : null };
        }
      } catch {
        results[index] = { number, error: "Hubnet did not respond. Retry this number." };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, numbers.length) }, () => verifyWorker()));

  const checkedAt = new Date().toISOString();
  for (const result of results) {
    if (!result.status) continue;
    const { error } = await service.from("agent_number_submissions").update({
      hubnet_status: result.status, hubnet_request_id: result.request_id ?? null, hubnet_checked_at: checkedAt,
    }).eq("agent_id", authData.user.id).eq("phone_number", result.number);
    if (error) result.error = "Hubnet responded, but the verification result could not be saved. Retry this number.";
  }
  return json(200, { success: results.every((result) => !!result.status), results, checked_at: checkedAt,
    message: "MTN eTopup beneficiary check complete. Queued numbers may be checked again after two minutes." });
});
