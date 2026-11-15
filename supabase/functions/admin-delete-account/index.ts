import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers });
function readKey(legacyName: string, collectionName: string): string | undefined {
  const direct = Deno.env.get(legacyName)?.trim();
  if (direct) return direct;
  try {
    const values = JSON.parse(Deno.env.get(collectionName) ?? "{}") as Record<string, unknown>;
    if (typeof values.default === "string") return values.default;
    const first = Object.values(values).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const authorization = request.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = readKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = readKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  if (!supabaseUrl || !anonKey || !serviceKey || !authorization?.startsWith("Bearer ")) {
    return json(401, { error: "Administrator sign-in is required." });
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user) return json(401, { error: "Your administrator session expired. Sign in again." });

  let body: { user_id?: unknown };
  try { body = await request.json(); } catch { return json(400, { error: "Request body must be JSON." }); }
  if (typeof body.user_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.user_id)) {
    return json(400, { error: "Select a valid account." });
  }
  if (body.user_id === authData.user.id) return json(400, { error: "You cannot delete your own administrator account here." });

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: admin, error: adminError } = await service.from("profiles").select("role")
    .eq("id", authData.user.id).maybeSingle();
  if (adminError || admin?.role !== "admin") return json(403, { error: "Administrator access required." });

  const { data: targetProfile, error: targetProfileError } = await service.from("profiles").select("role")
    .eq("id", body.user_id).maybeSingle();
  if (targetProfileError) return json(503, { error: "Could not verify the account being deleted." });
  if (!targetProfile) {
    const { data: targetAuth } = await service.auth.admin.getUserById(body.user_id);
    if (!targetAuth.user) return json(200, { success: true, message: "The account was already deleted." });
    return json(409, { error: "This login has no matching profile. Contact support before deleting it." });
  }
  if (targetProfile.role !== "customer") return json(403, { error: "Administrator accounts cannot be deleted from Agent management." });

  const { error: purgeError } = await service.rpc("admin_purge_agent_account", {
    p_user_id: body.user_id, p_admin_id: authData.user.id,
  });
  if (purgeError) return json(400, { error: purgeError.message || "Could not erase this account's records." });

  const { error: deleteError } = await service.auth.admin.deleteUser(body.user_id);
  if (deleteError) return json(500, {
    error: "Account records were purged, but the Auth login could not be deleted. Retry this deletion or contact support.",
    auth_delete_failed: true,
  });
  return json(200, { success: true, message: "The account and its associated records were permanently deleted." });
});
