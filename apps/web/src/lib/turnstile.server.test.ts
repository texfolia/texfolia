import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";

import { verifyLoginTurnstile } from "./turnstile.server";

const originalEnv = {
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET,
  TURNSTILE_HOSTNAMES: process.env.TURNSTILE_HOSTNAMES,
  NODE_ENV: process.env.NODE_ENV,
};
const headers = new Headers({ "x-captcha-response": "fresh-token" });
const fetchSpy = spyOn(globalThis, "fetch");

afterAll(() => fetchSpy.mockRestore());

beforeEach(() => {
  process.env.TURNSTILE_SECRET = "test-secret";
  process.env.TURNSTILE_HOSTNAMES = "app.example.com";
  process.env.NODE_ENV = "production";
  fetchSpy.mockReset();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("email login Turnstile verification", () => {
  it("allows only a successful verification for the login action and configured hostname", async () => {
    fetchSpy.mockResolvedValue(
      Response.json({
        success: true,
        action: "login",
        hostname: "app.example.com",
      }),
    );

    expect(await verifyLoginTurnstile(headers)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls.at(0);
    if (!call) throw new Error("Expected a Siteverify request");
    const [url, options] = call;
    expect(url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(options?.method).toBe("POST");
    expect(options?.body?.toString()).toBe(
      "secret=test-secret&response=fresh-token",
    );
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { success: false, "error-codes": ["timeout-or-duplicate"] },
    { success: true, action: "signup", hostname: "app.example.com" },
    { success: true, action: "login", hostname: "other.example.com" },
    { success: true, action: "login", hostname: "localhost" },
    { success: "true", action: "login", hostname: "app.example.com" },
    { success: true },
  ])(
    "rejects an invalid or replayed Siteverify response: %j",
    async (result) => {
      fetchSpy.mockResolvedValue(Response.json(result));
      expect(await verifyLoginTurnstile(headers)).toBe(false);
    },
  );

  it("rejects absent and oversized tokens before contacting Cloudflare", async () => {
    expect(await verifyLoginTurnstile(new Headers())).toBe(false);
    expect(
      await verifyLoginTurnstile(
        new Headers({ "x-captcha-response": "a".repeat(2049) }),
      ),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["TURNSTILE_SECRET", "TURNSTILE_HOSTNAMES"])(
    "fails closed when %s is not configured",
    async (key) => {
      delete process.env[key];
      expect(await verifyLoginTurnstile(headers)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects local hostnames in a production allowlist", async () => {
    process.env.TURNSTILE_HOSTNAMES = "app.example.com,localhost,127.0.0.1";
    expect(await verifyLoginTurnstile(headers)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows explicitly configured local hostnames in development", async () => {
    process.env.NODE_ENV = "development";
    process.env.TURNSTILE_HOSTNAMES = " localhost, 127.0.0.1 ";
    fetchSpy.mockResolvedValue(
      Response.json({ success: true, action: "login", hostname: "localhost" }),
    );
    expect(await verifyLoginTurnstile(headers)).toBe(true);
  });

  it("fails closed on a network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("Network unavailable"));
    expect(await verifyLoginTurnstile(headers)).toBe(false);
  });

  it("fails closed on HTTP and invalid JSON responses", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Unavailable", { status: 503 }),
    );
    expect(await verifyLoginTurnstile(headers)).toBe(false);
    fetchSpy.mockResolvedValueOnce(new Response("invalid JSON"));
    expect(await verifyLoginTurnstile(headers)).toBe(false);
  });
});
