// Cloudflare serves prerendered pages and assets without running the Worker, so
// public/_headers repeats these values. A test keeps the two in step.
export const securityHeaders = {
  // Other texfolia.com subdomains set their own policy.
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // Prerendered pages hydrate from inline scripts, which can't carry a
    // per-request nonce. The site has no sessions or user-written content.
    "script-src 'self' 'unsafe-inline'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
  ].join("; "),
};

export function withSecurityHeaders(response: Response, development = false) {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders)) {
    // Vite's dev server loads over plain HTTP and WebSockets.
    if (
      development &&
      (name === "Content-Security-Policy" ||
        name === "Strict-Transport-Security")
    )
      continue;
    secured.headers.set(name, value);
  }
  return secured;
}
