import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: cors });

function providerCode(body: string): string {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return String(parsed?.code ?? parsed?.status_code ?? parsed?.status ?? parsed?.message_code ?? "").trim();
  } catch { return trimmed.replace(/^"|"$/g, ""); }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Admin sign-in is required." });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const apiKey = Deno.env.get("SMSNOTIFYGH_API_KEY")?.trim();
  if (!url || !anon || !serviceKey) return json(503, { error: "Supabase function auth is not configured." });
  const auth = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your session is invalid or expired." });
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: profile, error: profileError } = await service.from("profiles").select("role").eq("id", authData.user.id).maybeSingle();
  if (profileError || profile?.role !== "admin") return json(403, { error: "Administrator access is required." });

  let body: { operation?: string; audience?: string; sender?: string; message?: string; recipients?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (body.operation === "balance") return json(501, { error: "SMSNotifyGH does not document an API credit-balance endpoint. Check credits in the SMS bundles page." });
  if (!apiKey) return json(503, { error: "Add SMSNOTIFYGH_API_KEY to Supabase Edge Function secrets first." });

  const { data: settings, error: settingsError } = await service.from("sms_provider_settings").select("sender_id").eq("id", true).maybeSingle();
  if (settingsError) return json(503, { error: "SMS provider settings could not be loaded. Apply the SMS provider migration." });
  const sender = String(body.sender ?? settings?.sender_id ?? "").trim();
  const message = String(body.message ?? "").trim();
  const recipients = Array.isArray(body.recipients) ? [...new Set(body.recipients.map((value) => String(value).replace(/\D/g, "")).filter((value) => /^0\d{9}$/.test(value)))] : [];
  if (!sender || sender.length > 11) return json(400, { error: "Set your SMSNotifyGH sender ID (maximum 11 characters)." });
  if (!message || message.length > 1600) return json(400, { error: "Message must contain 1 to 1600 characters." });
  if (!recipients.length || recipients.length > 500) return json(400, { error: "Choose 1 to 500 valid Ghanaian mobile numbers." });
  const allowedAudiences = ["all_agents", "overdraft_agents", "negative_balance_agents", "all_customers", "custom_numbers"];
  const audience = allowedAudiences.includes(String(body.audience)) ? String(body.audience) : "custom_numbers";

  const { data: campaign, error: insertError } = await service.from("bulk_sms_campaigns").insert({
    audience, message, recipient_count: recipients.length, status: "sending", provider: "smsnotifygh", created_by: authData.user.id,
  }).select("id").single();
  if (insertError || !campaign) return json(500, { error: "Could not create the SMS audit record; no text was sent." });

  let cursor = 0;
  let accepted = 0;
  let rejected = 0;
  const providerCounts: Record<string, number> = {};
  const sendOne = async (recipient: string) => {
    const params = new URLSearchParams({ key: apiKey, to: recipient, msg: message, sender_id: sender });
    try {
      const response = await fetch(`https://sms.smsnotifygh.com/smsapi?${params.toString()}`, { method: "GET", headers: { Accept: "application/json, text/plain" }, signal: AbortSignal.timeout(12000) });
      const code = providerCode(await response.text());
      providerCounts[code || `HTTP_${response.status}`] = (providerCounts[code || `HTTP_${response.status}`] ?? 0) + 1;
      if (response.ok && code === "1000") accepted++;
      else rejected++;
    } catch { providerCounts.timeout = (providerCounts.timeout ?? 0) + 1; rejected++; }
  };
  const workers = Array.from({ length: Math.min(5, recipients.length) }, async () => {
    while (cursor < recipients.length) {
      const recipient = recipients[cursor++];
      await sendOne(recipient);
    }
  });
  await Promise.all(workers);
  const status = accepted === recipients.length ? "sent" : accepted > 0 ? "partial" : "failed";
  const { error: updateError } = await service.from("bulk_sms_campaigns").update({ status, sent_count: accepted, failed_count: rejected, sent_at: new Date().toISOString() }).eq("id", campaign.id);
  if (updateError) return json(503, { error: `SMS processing finished (${accepted} accepted, ${rejected} rejected), but the campaign log could not be updated.`, campaign_id: campaign.id });
  const messageText = accepted ? `${accepted} message(s) accepted by SMSNotifyGH; ${rejected} rejected.` : providerCounts["1004"] ? "SMSNotifyGH rejected the API key. Check the key in provider settings." : providerCounts["1003"] ? "SMSNotifyGH reports insufficient SMS credits. Buy a plan in the SMS bundles page." : providerCounts["1006"] ? "SMSNotifyGH rejected the sender ID. Check that it is approved and no longer than 11 characters." : providerCounts["1005"] ? "SMSNotifyGH rejected one or more recipient numbers." : "SMSNotifyGH did not accept the messages. Check the provider API key and account.";
  return json(accepted ? 200 : 502, { success: accepted > 0, campaign_id: campaign.id, sent: accepted, failed: rejected, message: messageText });
});
