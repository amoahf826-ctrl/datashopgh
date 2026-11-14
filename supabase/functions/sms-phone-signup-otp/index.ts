const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
Deno.serve((request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  return new Response(JSON.stringify({ error: "SMS signup verification is disabled. Verify your account through the email link instead." }), {
    status: 410, headers,
  });
});
