const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
Deno.serve((request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  return new Response(JSON.stringify({ error: "SMS password recovery is disabled. Use the password reset link sent to your account email." }), {
    status: 410, headers,
  });
});
