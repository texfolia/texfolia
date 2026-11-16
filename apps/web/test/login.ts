import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Page, type Route } from "playwright";

// Exercise the actual login route and auth client. Only external authentication
// and Turnstile responses are fixtures; no email or OAuth provider is contacted.
const portReservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = portReservation.port;
portReservation.stop(true);
assert(port);
const origin = process.env.LOGIN_TEST_BASE_URL ?? `http://127.0.0.1:${port}`;
assert(
  ["127.0.0.1", "localhost"].includes(new URL(origin).hostname),
  "Use a local app for login tests",
);
// Cloudflare's Vite plugin must run in Node, as it does under `bun run dev`.
const server = process.env.LOGIN_TEST_BASE_URL
  ? null
  : Bun.spawn(
      [
        "bun",
        "run",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdout: "inherit",
        stderr: "inherit",
      },
    );
const browser = await chromium.launch({ headless: true });
const browserErrors: string[] = [];
const turnstileScript = `
  let options;
  let serial = 0;
  window.turnstile = {
    render(container, callbacks) {
      options = callbacks;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Complete security check';
      button.onclick = () => options.callback('login-test-token-' + ++serial);
      container.append(button);
      return 'login-test-widget';
    },
    reset() {},
    remove() {},
    execute() {},
    getResponse() { return ''; },
    isExpired() { return false; },
  };
  window.loginCaptcha = {
    expire: () => options['expired-callback'](),
    fail: () => options['error-callback']('provider unavailable'),
  };
  window[new URL(document.currentScript.src).searchParams.get('onload')]();
`;

type Reply =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | "offline";
let sendReply: Reply = { status: 200, body: { success: true } };
let verifyReply: Reply = { status: 400, body: { code: "INVALID_OTP" } };
let socialReply: Reply = { status: 404, body: { code: "PROVIDER_NOT_FOUND" } };
let releaseRequest: Promise<void> | undefined;
const deliveries: { email: string; token: string }[] = [];
const verifications: unknown[] = [];
const socialRequests: {
  provider: string;
  callbackURL: string;
  errorCallbackURL: string;
}[] = [];

async function reply(route: Route, response: Reply) {
  await releaseRequest;
  if (response === "offline") return route.abort("internetdisconnected");
  await route.fulfill({
    status: response.status,
    contentType: "application/json",
    body: JSON.stringify(response.body),
    headers: response.headers,
  });
}

async function visibleError(page: Page, text: string) {
  await page.getByRole("alert").filter({ hasText: text }).waitFor();
}

async function captcha(page: Page) {
  await page.getByRole("button", { name: "Complete security check" }).click();
}

async function send(page: Page) {
  await page.getByLabel("Email", { exact: true }).fill("person@example.com");
  await captcha(page);
  await page
    .getByRole("button", { name: "Continue with email", exact: true })
    .click();
}

try {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      if (
        (
          await fetch(new URL("/login", origin), {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        break;
    } catch {}
    assert(Date.now() < deadline, "Local login page did not become ready");
    await Bun.sleep(100);
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: turnstileScript,
    }),
  );
  await context.route("**/api/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/email-otp/send-verification-otp") {
      const body = request.postDataJSON();
      assert.equal(body.type, "sign-in");
      deliveries.push({
        email: body.email,
        token: request.headers()["x-captcha-response"] ?? "",
      });
      return reply(route, sendReply);
    }
    if (path === "/api/auth/sign-in/email-otp") {
      verifications.push(request.postDataJSON());
      return reply(route, verifyReply);
    }
    if (path === "/api/auth/sign-in/social") {
      socialRequests.push(request.postDataJSON());
      return reply(route, socialReply);
    }
    return route.fulfill({ contentType: "application/json", body: "null" });
  });
  await context.route("**/projects", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Projects destination</h1>",
    }),
  );
  await context.route(
    (url) => url.pathname.startsWith("/accept-invitation/"),
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Invitation destination</h1>",
      }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.clock.install();
  const login = async (redirectTo?: string, error?: string) => {
    const url = new URL("/login", origin);
    if (redirectTo !== undefined)
      url.searchParams.set("redirectTo", redirectTo);
    if (error) url.searchParams.set("error", error);
    await page.goto(url.href);
    await page
      .getByRole("button", { name: "Complete security check" })
      .waitFor();
  };

  const capture = async (name: string) => {
    const directory = process.env.LOGIN_TEST_ARTIFACT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: join(directory, `${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  };

  console.info(
    "Checking keyboard access to the sign-in form at public viewport widths",
  );
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await login();
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to sign-in form" });
    assert(
      await skip.evaluate((element) => element === document.activeElement),
    );
    const bounds = await skip.boundingBox();
    assert(bounds && bounds.width > 1 && bounds.height > 1);
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await capture(`skip-link-${width}`);
    await page.keyboard.press("Enter");
    const signIn = page.getByRole("form", { name: "Sign in", exact: true });
    assert(
      await signIn.evaluate((element) => element === document.activeElement),
    );
    await page.keyboard.press("Tab");
    assert(
      await page
        .getByRole("button", { name: "Continue with GitHub" })
        .evaluate((element) => element === document.activeElement),
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  console.info(
    "Checking delivery failures, network recovery, and fresh CAPTCHA tokens",
  );
  await login();
  assert.equal(
    await page
      .getByRole("navigation", { name: "Legal information" })
      .innerText(),
    "Read our Privacy Policy and Terms of Service.",
  );
  assert.equal(
    await page.getByText(/^Complete the security check to/).count(),
    0,
  );
  await capture("email-desktop");
  await page.getByLabel("Email", { exact: true }).fill("person@example.com");
  assert(
    await page
      .getByRole("button", { name: "Continue with email", exact: true })
      .isDisabled(),
  );
  sendReply = { status: 503, body: { message: "Internal provider details" } };
  await send(page);
  await visibleError(page, "couldn't send a code");
  assert.equal(
    await page.getByLabel("Email", { exact: true }).inputValue(),
    "person@example.com",
  );
  assert(
    await page
      .getByRole("button", { name: "Continue with email", exact: true })
      .isDisabled(),
  );
  sendReply = "offline";
  await captcha(page);
  await page
    .getByRole("button", { name: "Continue with email", exact: true })
    .click();
  await visibleError(page, "Check your connection");
  assert(
    await page
      .getByRole("button", { name: "Continue with email", exact: true })
      .isDisabled(),
  );
  sendReply = {
    status: 429,
    body: { message: "Too many requests" },
    headers: { "X-Retry-After": "90" },
  };
  await captcha(page);
  await page
    .getByRole("button", { name: "Continue with email", exact: true })
    .click();
  await visibleError(page, "Too many attempts");
  await page.getByText("Try again in 90s.", { exact: true }).waitFor();
  await captcha(page);
  await page.clock.fastForward(89_000);
  assert(
    await page
      .getByRole("button", { name: /Send another code in/ })
      .isDisabled(),
  );
  await page.clock.fastForward(2_000);
  sendReply = { status: 200, body: { success: true } };
  const heldSend = Promise.withResolvers<void>();
  releaseRequest = heldSend.promise;
  await page
    .getByRole("button", { name: "Continue with email", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sending code…", exact: true })
    .waitFor();
  assert(
    await page
      .getByRole("button", { name: "Sending code…", exact: true })
      .isDisabled(),
  );
  assert(
    await page
      .getByRole("button", { name: "Continue with GitHub" })
      .isDisabled(),
  );
  heldSend.resolve();
  releaseRequest = undefined;
  await page.getByRole("heading", { name: "Check your email" }).waitFor();
  await page.getByRole("status").filter({ hasText: "Code sent" }).waitFor();
  assert(
    await page
      .getByLabel("One-time password", { exact: true })
      .evaluate((element) => element === document.activeElement),
  );
  await capture("otp-desktop");
  assert.equal(
    new Set(deliveries.map(({ token }) => token)).size,
    deliveries.length,
  );
  assert(
    deliveries.every(({ token }) => token.startsWith("login-test-token-")),
  );

  console.info(
    "Checking explicit verification, invalid/expired codes, limits, and resend",
  );
  const otp = page.getByLabel("One-time password", { exact: true });
  const otpSlots = await page.locator('[data-slot="input-otp-group"]').all();
  const firstGroup = await otpSlots[0]?.boundingBox();
  const lastGroup = await otpSlots[1]?.boundingBox();
  const formBounds = await page
    .getByRole("form", { name: "Sign in", exact: true })
    .boundingBox();
  assert(firstGroup && lastGroup && formBounds);
  assert(
    Math.abs(
      (firstGroup.x + lastGroup.x + lastGroup.width) / 2 -
        (formBounds.x + formBounds.width / 2),
    ) < 1,
  );
  const verify = page.getByRole("button", {
    name: "Verify and sign in",
    exact: true,
  });
  await verify.click();
  await visibleError(page, "Enter the six-digit code");
  assert.equal(verifications.length, 0);
  await otp.fill("123456");
  assert.equal(
    verifications.length,
    0,
    "Typing a complete code must not submit it",
  );
  await verify.click();
  await visibleError(page, "incorrect or no longer valid");
  assert.equal(await otp.inputValue(), "123456");
  await capture("invalid-code-desktop");
  await page.setViewportSize({ width: 320, height: 640 });
  await capture("invalid-code-mobile");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter(
            (element) =>
              element.getBoundingClientRect().right > window.innerWidth,
          )
          .map((element) => ({
            tag: element.tagName,
            slot: element.getAttribute("data-slot"),
            width: element.getBoundingClientRect().width,
          }))
          .slice(0, 10),
      ),
    ),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await otp.waitFor({ state: "visible" });
  verifyReply = { status: 400, body: { code: "OTP_EXPIRED" } };
  await verify.click();
  await visibleError(page, "code has expired");
  verifyReply = { status: 403, body: { code: "TOO_MANY_ATTEMPTS" } };
  await verify.click();
  await visibleError(page, "tried too many times");
  verifyReply = {
    status: 429,
    body: { message: "Too many requests" },
    headers: { "Retry-After": "120" },
  };
  await verify.click();
  await visibleError(page, "Too many attempts");
  await page.getByText("Try again in 120s.", { exact: true }).waitFor();
  assert(await verify.isDisabled());
  await page.clock.fastForward(121_000);
  const resend = page.getByRole("button", { name: "Resend code", exact: true });
  assert(await resend.isDisabled(), "Resend needs a new CAPTCHA token");
  await captcha(page);
  sendReply = { status: 503, body: {} };
  await resend.click();
  await visibleError(page, "couldn't send a code");
  assert.equal(
    await otp.inputValue(),
    "123456",
    "Failed resend must preserve the existing code",
  );
  assert(await resend.isDisabled());
  await captcha(page);
  sendReply = { status: 200, body: { success: true } };
  await resend.click();
  await page
    .getByRole("status")
    .filter({ hasText: "A new code has been sent" })
    .waitFor();
  assert.equal(await otp.inputValue(), "");
  assert(
    await page.getByRole("button", { name: /Resend code in/ }).isDisabled(),
  );
  assert.equal(deliveries.at(-1)?.email, "person@example.com");
  await page.clock.fastForward(61_000);
  await captcha(page);
  await page.evaluate(() => Reflect.get(window, "loginCaptcha").expire());
  await visibleError(page, "security check expired");
  assert(await resend.isDisabled());
  await page.getByRole("button", { name: "Retry security check" }).click();
  await captcha(page);
  await page.evaluate(() => Reflect.get(window, "loginCaptcha").fail());
  await visibleError(page, "security check is unavailable");
  assert(await resend.isDisabled());
  await page.getByRole("button", { name: "Retry security check" }).click();
  await captcha(page);
  await resend.click();
  await page
    .getByRole("status")
    .filter({ hasText: "A new code has been sent" })
    .waitFor();
  const attemptsBeforeBack = verifications.length;
  await page.getByRole("button", { name: "Change email" }).click();
  await page.clock.runFor(20);
  await page.getByRole("heading", { name: "Sign in to Texfolia" }).waitFor();
  assert(
    await page
      .getByLabel("Email", { exact: true })
      .evaluate((element) => element === document.activeElement),
  );
  assert.equal(verifications.length, attemptsBeforeBack);
  assert.equal(
    await page.getByLabel("Email", { exact: true }).inputValue(),
    "person@example.com",
  );

  console.info("Checking OAuth failures and safe callback paths");
  const invitation = "/accept-invitation/invitation-test?from=email";
  await login(invitation);
  for (const provider of ["GitHub", "GitLab", "Google", "Microsoft"]) {
    const heldSocial = Promise.withResolvers<void>();
    releaseRequest = heldSocial.promise;
    await page
      .getByRole("button", { name: `Continue with ${provider}`, exact: true })
      .click();
    const connecting = page.getByRole("button", {
      name: `Connecting to ${provider}…`,
    });
    await connecting.waitFor();
    assert(await connecting.isDisabled());
    heldSocial.resolve();
    releaseRequest = undefined;
    await visibleError(page, "provider is unavailable");
    assert.equal(socialRequests.at(-1)?.callbackURL, invitation);
    assert.equal(
      socialRequests.at(-1)?.errorCallbackURL,
      `/login?redirectTo=${encodeURIComponent(invitation)}`,
    );
  }
  socialReply = "offline";
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await visibleError(page, "Check your connection");
  await login(invitation, "access_denied");
  await visibleError(page, "Sign-in could not be completed");

  console.info("Checking a failed Turnstile script load and reload recovery");
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.abort(),
  );
  await page.goto(new URL("/login", origin).href);
  await visibleError(page, "security check is unavailable");
  assert(
    await page
      .getByRole("button", { name: "Continue with email", exact: true })
      .isDisabled(),
  );
  assert(
    await page
      .getByRole("button", { name: "Continue with GitHub" })
      .isEnabled(),
  );
  await capture("captcha-unavailable");
  await page.unroute("https://challenges.cloudflare.com/**");
  await page.getByRole("button", { name: "Retry security check" }).click();
  await page.getByRole("button", { name: "Complete security check" }).waitFor();

  console.info(
    "Checking successful OTP login, invitation returns, and unsafe redirects",
  );
  verifyReply = {
    status: 200,
    body: {
      token: "fixture-session",
      user: { id: "login-test", email: "person@example.com" },
    },
  };
  for (const [target, expected] of [
    [undefined, "/projects"],
    [invitation, invitation],
    ["https://attacker.example", "/projects"],
    ["//attacker.example", "/projects"],
    ["/\\attacker.example", "/projects"],
    ["/\n/attacker.example", "/projects"],
  ]) {
    await login(target);
    await send(page);
    await page.getByRole("heading", { name: "Check your email" }).waitFor();
    await otp.fill("654321");
    const heldVerify = Promise.withResolvers<void>();
    releaseRequest = heldVerify.promise;
    await verify.click();
    await page
      .getByRole("button", { name: "Verifying…", exact: true })
      .waitFor();
    assert(
      await page
        .getByRole("button", { name: "Verifying…", exact: true })
        .isDisabled(),
    );
    heldVerify.resolve();
    releaseRequest = undefined;
    await page.waitForURL(new URL(expected ?? "", origin).href);
    await page.getByRole("heading", { name: /destination/ }).waitFor();
  }
  assert.deepEqual(browserErrors, []);
  console.info("Rendered login flow passed");
} finally {
  await browser.close();
  server?.kill();
  await server?.exited;
}
