export async function servePanel(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  const url = new URL(request.url);
  if (url.pathname === "/login" || url.pathname === "/panel")
    url.pathname = "/";
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const response = new Response(asset.body, asset);
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Cache-Control", "no-store");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return response;
}
