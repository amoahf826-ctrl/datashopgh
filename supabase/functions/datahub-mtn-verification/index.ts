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
type VerificationStatus = "verified" | "unverified" | "invalid";
type Result = { number: string; status?: VerificationStatus; status_label?: string; error?: string; http_status?: number };

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Sign in is required." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const datahubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
  if (!supabaseUrl || !anonKey || !serviceKey) return json(503, { error: "Supabase function auth is not configured." });
  if (!datahubKey) return json(503, { error: "DataHub API key is not configured." });

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session is invalid or expired." });
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { numbers?: unknown; networkKey?: unknown; purpose?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  const networkKey = body.networkKey === "mtn_xpress" ? "mtn_xpress" : body.networkKey === "YELLO" || body.networkKey == null ? "YELLO" : null;
  if (!networkKey) return json(400, { error: "Choose a supported MTN network." });
  if (!Array.isArray(body.numbers) || body.numbers.length < 1 || body.numbers.length > 30 ||
      body.numbers.some((number) => typeof number !== "string" || !/^0\d{9}$/.test(number))) {
    return json(400, { error: "Submit 1 to 30 valid 10-digit Ghanaian phone numbers per check." });
  }
  const numbers = [...new Set(body.numbers as string[])];
  if (body.purpose !== "bulk_order_preview") {
    const { data: submissions, error: submissionsError } = await service.from("number_verification_submissions")
      .select("phone_number").eq("user_id", authData.user.id).in("phone_number", numbers);
    if (submissionsError) return json(503, { error: "Could not verify these submitted numbers." });
    const ownedNumbers = new Set((submissions ?? []).map((row) => row.phone_number));
    if (numbers.some((number) => !ownedNumbers.has(number))) return json(403, { error: "Submit these numbers through your account before checking them." });
  }

  const results: Result[] = new Array(numbers.length);
  let next = 0;
  async function verifyWorker() {
    while (next < numbers.length) {
      const index = next++;
      const number = numbers[index];
      try {
        const response = await fetch("https://user.datahubgh.com/api/external/purchases/verify-number", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": datahubKey, Accept: "application/json" },
          body: JSON.stringify({ phone: number, is_ported_number: true }),
          // Allow DataHub enough time to return its live beneficiary status.
          signal: AbortSignal.timeout(30000),
        });
        const payload = await response.json().catch(() => null);
        const providerMessage = String(payload?.error ?? payload?.message ?? "");
        const explicitlyVerified = payload?.success === true &&
          (payload?.data?.verified === true || payload?.data?.exists === true);
        const explicitlyUnverified = payload?.data?.verified === false || payload?.data?.exists === false ||
          /phone number not verified|not added to.*beneficiar/i.test(providerMessage);
        if (response.ok && explicitlyVerified) {
          results[index] = { number, status: "verified" };
        } else if ((response.ok || response.status === 400) && explicitlyUnverified) {
          results[index] = { number, status: "unverified" };
        } else if (response.status === 400 && payload?.success === false) {
          results[index] = { number, status: "invalid" };
        } else {
        results[index] = { number, error: "Could not verify right now. Please try again.", http_status: response.status };
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (timedOut) console.warn("DataHub number verification timed out.");
        else console.error("DataHub number verification request failed.", error instanceof Error ? error.message : "Unknown request error");
        results[index] = { number, error: "Could not verify right now. Please try again.", http_status: 0 };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, numbers.length) }, () => verifyWorker()));

  const checkedAt = new Date().toISOString();
  const persistence = await Promise.all(results.map(async (result) => {
    if (!result.status) return false;
    const { error } = await service.from("number_verification_submissions").update({
      verification_status: result.status, hubnet_status: null, hubnet_error: null,
      hubnet_checked_at: checkedAt, updated_at: checkedAt,
    }).eq("user_id", authData.user.id).eq("phone_number", result.number);
    if (error) result.error = "The result could not be saved.";
    return !error;
  }));
  const success = results.every((result) => !!result.status) && persistence.every(Boolean);
  return json(200, {
    success,
    results: results.map((result) => ({ number: result.number, status: result.status ?? null, status_label: result.status_label ?? null, error: result.error ?? null, http_status: result.http_status ?? null })),
    message: `DataHub checked ${results.filter((result) => !!result.status).length} of ${numbers.length} number(s).`,
    checked_at: checkedAt,
  });
});
