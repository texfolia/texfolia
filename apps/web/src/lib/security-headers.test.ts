import { expect, test } from "bun:test";

import { withSecurityHeaders } from "./security-headers";

test("security headers preserve redirects and separate session cookies", () => {
  const response = Response.redirect(
    "https://github.com/login/oauth/authorize",
  );
  const secured = withSecurityHeaders({
    response,
    nonce: "test-nonce",
    url: "https://www.texfolia.com/api/auth/callback/github",
  });
  expect(secured.status).toBe(302);
  expect(secured.headers.get("Location")).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(secured.headers.get("Content-Security-Policy")).toContain(
    "connect-src 'self' wss://www.texfolia.com blob:",
  );

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", "session=one; HttpOnly; Secure");
  headers.append("Set-Cookie", "state=two; HttpOnly; Secure");
  const authenticated = withSecurityHeaders({
    response: new Response(null, { headers }),
    nonce: "test-nonce",
    url: "https://www.texfolia.com/api/auth/get-session",
  });
  expect(authenticated.headers.getSetCookie()).toEqual(headers.getSetCookie());
  expect(authenticated.headers.get("Cache-Control")).toBe("no-store");
});

test("API, errors, and PDF streams retain their body, status, and headers", async () => {
  for (const status of [200, 401, 404, 500]) {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const response = new Response(stream.readable, {
      status,
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
      },
    });
    const secured = withSecurityHeaders({
      response,
      nonce: "test-nonce",
      url: "https://www.texfolia.com/api/compile/project/pdf",
    });
    expect(secured.body).toBe(response.body);
    expect(secured.status).toBe(status);
    expect(secured.headers.get("Content-Type")).toBe("application/pdf");
    expect(secured.headers.get("Cache-Control")).toBe("no-store");
    expect(secured.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(secured.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(secured.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    const writer = stream.writable.getWriter();
    const body = secured.text();
    await writer.write(new TextEncoder().encode("PDF stream"));
    await writer.close();
    expect(await body).toBe("PDF stream");
  }
});

test("development keeps Vite scripts working and retains baseline headers", () => {
  const response = withSecurityHeaders({
    response: new Response("development"),
    nonce: "test-nonce",
    url: "http://localhost:3000",
    development: true,
  });
  expect(response.headers.has("Content-Security-Policy")).toBe(false);
  expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
});
