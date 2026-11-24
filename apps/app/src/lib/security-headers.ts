export const cspNonceHeader = "x-texfolia-csp-nonce";

export function withSecurityHeaders({
  response,
  nonce,
  url,
  development = false,
}: {
  response: Response;
  nonce: string;
  url: string;
  development?: boolean;
}) {
  // Leave the Workers WebSocket upgrade and its socket attached to the response.
  if (response.status === 101) return response;

  const secured = new Response(response.body, response);
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("X-Frame-Options", "SAMEORIGIN");
  secured.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Vite's refresh preamble uses inline scripts without a nonce in development.
  if (!development) {
    // Browsers ignore this over plain HTTP, so local production builds still work.
    secured.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    const websocket = new URL(url);
    websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
    secured.headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval' https://challenges.cloudflare.com`,
        "script-src-attr 'none'",
        // CodeMirror, dockview, React, and user themes generate styles at runtime.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: blob:",
        `connect-src 'self' ${websocket.origin} blob:`,
        "worker-src 'self' blob:",
        "frame-src https://challenges.cloudflare.com",
        "form-action 'self'",
      ].join("; "),
    );
  }
  return secured;
}
