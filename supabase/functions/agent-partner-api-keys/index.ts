import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers });
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
function readKey(legacyName: string, collectionName: string): string | undefined {
  const direct = Deno.env.get(legacyName)?.trim();
  if (direct) return direct;
  try { const values = JSON.parse(Deno.env.get(collectionName) ?? "{}") as Record<string, unknown>; const value = values.default ?? Object.values(values).find((item) => typeof item === "string"); return typeof value === "string" ? value : undefined; } catch { return undefined; }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });
  const url = Deno.env.get("SUPABASE_URL"), anon = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS"), serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!url || !anon || !serviceKey) return reply(503, { error: "API key management is unavailable." });
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply(401, { error: "Sign in to manage your provider API key." });
  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return reply(401, { error: "Your session expired. Sign in again." });
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: agent } = await service.from("agent_accounts").select("user_id,is_active,deleted_at").eq("user_id", user.id).maybeSingle();
  if (!agent?.is_active || agent.deleted_at) return reply(403, { error: "An active agent account is required." });
  let body: { action?: string; key_id?: string };
  try { body = await request.json(); } catch { return reply(400, { error: "Request body must be JSON." }); }
  if (body.action === "list") {
    const { data, error } = await service.from("agent_partner_api_keys").select("id,key_prefix,created_at,last_used_at,revoked_at").eq("agent_id", user.id).order("created_at", { ascending: false });
    return error ? reply(500, { error: "Could not load API keys." }) : reply(200, { success: true, keys: data ?? [] });
  }
  if (body.action === "revoke") {
    if (!body.key_id || !/^[0-9a-f-]{36}$/i.test(body.key_id)) return reply(400, { error: "Choose a valid API key." });
    const { data, error } = await service.from("agent_partner_api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", body.key_id).eq("agent_id", user.id).is("revoked_at", null).select("id").maybeSingle();
    return error ? reply(500, { error: "Could not revoke that API key." }) : data ? reply(200, { success: true }) : reply(404, { error: "Active API key not found." });
  }
  if (body.action !== "create") return reply(400, { error: "Choose create, list, or revoke." });
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const rawKey = `cdb_live_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const prefix = rawKey.slice(0, 16), keyHash = await hash(rawKey);
  const { error } = await service.from("agent_partner_api_keys").insert({ agent_id: user.id, key_hash: keyHash, key_prefix: prefix });
  if (error) return reply(500, { error: "Could not create an API key." });
  return reply(200, { success: true, api_key: rawKey, prefix, warning: "Copy this key now. It cannot be displayed again." });
});
