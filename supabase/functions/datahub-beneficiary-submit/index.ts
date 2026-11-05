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
  const datahubKey = Deno.env.get("DATAHUB_API_KEY")?.trim();
  if (!supabaseUrl || !anonKey || !serviceKey) return json(503, { error: "Supabase function auth is not configured." });
  if (!datahubKey) return json(503, { error: "DataHub API key is not configured in Edge Function secrets." });

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session is invalid or expired." });
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: { numbers?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (!Array.isArray(body.numbers) || body.numbers.length < 1 || body.numbers.length > 30 ||
      body.numbers.some((number) => typeof number !== "string" || !/^0\d{9}$/.test(number))) {
    return json(400, { error: "Submit 1 to 30 valid 10-digit MTN numbers per request." });
  }
  const numbers = [...new Set(body.numbers as string[])];
  const { data: submissions, error: submissionsError } = await service.from("number_verification_submissions")
    .select("phone_number").eq("user_id", authData.user.id).in("phone_number", numbers);
  if (submissionsError) return json(503, { error: "Could not confirm these numbers belong to your account." });
  const ownedNumbers = new Set((submissions ?? []).map((row) => row.phone_number));
  if (numbers.some((number) => !ownedNumbers.has(number))) return json(403, { error: "Submit these numbers through your account before sending them to DataHub." });

  let response: Response;
  try {
    response = await fetch("https://user.datahubgh.com/api/external/purchases/submit-numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": datahubKey, Accept: "application/json" },
      // The current endpoint accepts a string or array; send the documented
      // comma-separated form for compatibility with its new route.
      body: JSON.stringify({ numbers: numbers.join(", ") }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return json(502, { error: "DataHub could not be reached. Wait briefly before retrying." });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status === 401 ? 502 : 400;
    return json(status, { error: payload?.error ?? payload?.message ?? `DataHub beneficiary submission failed (HTTP ${response.status}).` });
  }

  const data = payload.data ?? {};
  const invalidValues: unknown[] = Array.isArray(data.invalid) ? data.invalid : [];
  const invalidNumbers = new Set(invalidValues.map((value) => normalizedNumber(typeof value === "object" && value ? (value as Record<string, unknown>).number : value)));
  const submittedAt = new Date().toISOString();
  const acceptedNumbers = numbers.filter((number) => !invalidNumbers.has(number));
  const rejectedNumbers = numbers.filter((number) => invalidNumbers.has(number));
  const updates = await Promise.all([
    acceptedNumbers.length ? service.from("number_verification_submissions").update({ datahub_status: "submitted", datahub_submitted_at: submittedAt, updated_at: submittedAt }).eq("user_id", authData.user.id).in("phone_number", acceptedNumbers) : Promise.resolve({ error: null }),
    rejectedNumbers.length ? service.from("number_verification_submissions").update({ datahub_status: "invalid", datahub_submitted_at: submittedAt, updated_at: submittedAt }).eq("user_id", authData.user.id).in("phone_number", rejectedNumbers) : Promise.resolve({ error: null }),
  ]);
  if (updates.some((result) => result.error)) return json(503, { error: "DataHub accepted the request, but the submission status could not be saved. Contact support before retrying." });

  return json(200, {
    success: true,
    message: payload.message ?? `Submitted ${Number(data.submitted ?? acceptedNumbers.length)} number(s) for DataHub beneficiary approval.`,
    data: {
      submitted: Number(data.submitted ?? acceptedNumbers.length),
      tracked: Number(data.tracked ?? acceptedNumbers.length),
      numbers: Array.isArray(data.numbers) ? data.numbers : acceptedNumbers,
      invalid: invalidValues,
      batches: Number(data.batches ?? 1),
      maxPerRequest: 30,
    },
    submitted_at: submittedAt,
  });
});
