import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  aiRequest,
  aiRun,
  aiThread,
  aiMessage,
  project,
  projectNode,
  projectGit,
  session,
  subscription,
  user,
} from "@texfolia/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { chromium } from "playwright";
import { z } from "zod";

import { threadHistorySchema, threadSchema } from "../src/lib/ai/threads";
import { GitRepository } from "../src/lib/git-repository.server";
import { hashSource } from "../src/lib/latex/source-sync";
import { createProject } from "../src/lib/project.server";

const connection = process.env.INTEGRATION_DATABASE_URL;
assert(
  connection && new URL(connection).pathname.includes("test"),
  "Use an isolated test database",
);
const db = createDb(connection);
const directory = await mkdtemp(join(tmpdir(), "texfolia-ai-"));
const root = new URL("../dist/server/", import.meta.url).pathname;
const filenames = await readdir(root, { recursive: true });
const userId = crypto.randomUUID();
const freeId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const projectIds: string[] = [];
const secret = "ai-assistant-fixture-secret-not-for-production";
const accountId = "a".repeat(32);
const source =
  "\\documentclass{article}\n\\begin{document}\nOriginal text.\n\\end{document}\n";
const sourceHash = await hashSource(new TextEncoder().encode(source));
let objectKey = "";
let mode: "tools" | "error" | "simple" | "slow" = "tools";
let call = 0;
let logCalls = 0;
const inference: { headers: Pick<Headers, "get">; body: unknown }[] = [];
const meterEvents: URLSearchParams[] = [];
const compileJobs = new Map<string, string>();
const model = {
  id: "@cf/test/model",
  name: "Fixture model",
  pricing: { prompt: "0.000001", completion: "0.000002" },
  supported_parameters: ["tools", "max_tokens"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
};
const portReservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = portReservation.port;
portReservation.stop(true);
assert(port);
const origin = `http://127.0.0.1:${port}`;
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    name: "ai-assistant-test",
    modules: filenames
      .filter((p) => p.endsWith(".js"))
      .sort((a, b) =>
        a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b),
      )
      .map((p) => ({ type: "ESModule", path: join(root, p) })),
    modulesRoot: root,
    compatibilityDate: "2025-09-02",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      directory: new URL("../dist/client/", import.meta.url).pathname,
      routerConfig: { has_user_worker: true },
    },
    durableObjects: {
      COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
    },
    r2Buckets: ["SOURCES"],
    hyperdrives: { HYPERDRIVE: connection },
    bindings: {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: origin,
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_AI_PRICE_ID: "price_ai",
      STRIPE_AI_METER_EVENT_NAME: "ai_nanos",
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_AI_GATEWAY_ID: "test",
      CLOUDFLARE_AI_API_TOKEN: "fixture-ai-token",
      ...Object.fromEntries(
        ["GITHUB", "GOOGLE", "GITLAB", "MICROSOFT"].flatMap((p) => [
          [`${p}_CLIENT_ID`, "fixture"],
          [`${p}_CLIENT_SECRET`, "fixture"],
        ]),
      ),
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.stripe.com") {
        if (url.pathname === "/v1/prices/price_ai")
          return Response.json({
            id: "price_ai",
            currency: "usd",
            unit_amount_decimal: "0.0000001",
            recurring: {
              interval: "month",
              interval_count: 1,
              usage_type: "metered",
              meter: "mtr_ai",
            },
          });
        if (url.pathname === "/v1/subscriptions/sub_pro")
          return Response.json({
            id: "sub_pro",
            customer: "cus_pro",
            status: "active",
            items: { data: [{ id: "si_ai", price: { id: "price_ai" } }] },
          });
        if (url.pathname === "/v1/billing/meters/mtr_ai")
          return Response.json({
            id: "mtr_ai",
            event_name: "ai_nanos",
            status: "active",
            default_aggregation: { formula: "sum" },
            customer_mapping: {
              type: "by_id",
              event_payload_key: "stripe_customer_id",
            },
            value_settings: { event_payload_key: "value" },
          });
        if (url.pathname === "/v1/billing/meter_events") {
          const body = new URLSearchParams(await request.text());
          meterEvents.push(body);
          assert.equal(body.get("payload[value]"), "12000000");
          assert.equal(body.get("payload[stripe_customer_id]"), "cus_pro");
          assert.equal(
            request.headers.get("Idempotency-Key"),
            body.get("identifier"),
          );
          return Response.json({
            object: "billing.meter_event",
            identifier: body.get("identifier"),
          });
        }
      }
      if (url.hostname === "api.cloudflare.com") {
        assert.equal(
          request.headers.get("Authorization"),
          "Bearer fixture-ai-token",
        );
        if (url.pathname.endsWith("/ai/models/search"))
          return Response.json({
            data: [
              model,
              { ...model, id: "@cf/test/second", name: "Second model" },
            ],
          });
        if (url.pathname.includes("/logs/")) {
          logCalls++;
          return Response.json({
            success: true,
            result: {
              id: url.pathname.split("/").at(-1),
              model: model.id,
              cost: 0.01,
              tokens_in: 80,
              tokens_out: 20,
            },
          });
        }
        if (url.pathname.endsWith("/ai/v1/chat/completions")) {
          inference.push({
            headers: request.headers,
            body: await request.json(),
          });
          assert.equal(request.headers.get("cf-aig-gateway-id"), "test");
          assert.equal(request.headers.get("cf-aig-max-attempts"), "1");
          const metadata = z
            .object({ runId: z.uuid(), requestId: z.uuid() })
            .parse(JSON.parse(request.headers.get("cf-aig-metadata") ?? "{}"));
          const [reserved] = await db
            .select()
            .from(aiRequest)
            .where(eq(aiRequest.id, metadata.requestId));
          assert(reserved, "Usage reservation is durable before inference");
          const headers = {
            "Content-Type": "text/event-stream",
            "cf-aig-log-id": crypto.randomUUID(),
          };
          if (mode === "error")
            return Response.json(
              {
                error: {
                  message: "Provider fixture failed",
                  type: "provider_error",
                },
              },
              { status: 500, headers },
            );
          const toolCalls = [
            { name: "list_files", args: {} },
            { name: "read_file", args: { path: "main.tex" } },
            {
              name: "edit_file",
              args: {
                path: "main.tex",
                version: objectKey,
                oldText: "Original text.",
                newText: "Revised text.",
              },
            },
            { name: "compile", args: { mainFile: "main.tex" } },
            {
              name: "read_compile_logs",
              args: {
                jobId: [...compileJobs.keys()].at(-1) ?? crypto.randomUUID(),
                mainFile: "main.tex",
              },
            },
          ];
          const tool = mode === "tools" ? toolCalls[call++] : undefined;
          const chunk = (delta: unknown, finish: string | null = null) => ({
            id: "completion-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
          const chunks: Array<
            ReturnType<typeof chunk> & {
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
              };
            }
          > = tool
            ? [
                chunk({
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${call}`,
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: JSON.stringify(tool.args),
                      },
                    },
                  ],
                }),
                chunk({}, "tool_calls"),
              ]
            : [
                chunk({
                  role: "assistant",
                  content: "Updated main.tex and submitted a compile.",
                }),
                chunk({}, "stop"),
              ];
          chunks.push({
            ...chunk({}),
            choices: [],
            usage: {
              prompt_tokens: 80,
              completion_tokens: 20,
              total_tokens: 100,
            },
          });
          const data =
            chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
            "data: [DONE]\n\n";
          if (mode === "slow") {
            const encoder = new TextEncoder();
            let timer: ReturnType<typeof setTimeout>;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify(chunk({ role: "assistant", content: "Working…" }))}\n\n`,
                    ),
                  );
                  timer = setTimeout(() => {
                    controller.enqueue(encoder.encode(data));
                    controller.close();
                  }, 2000);
                },
                cancel() {
                  clearTimeout(timer);
                },
              }),
              { headers },
            );
          }
          return new Response(data, { headers });
        }
      }
      throw new Error(
        `Unexpected external request: ${url.hostname}${url.pathname}`,
      );
    },
    serviceBindings: {
      COMPILER: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/changed"))
          return new Response(null, { status: 204 });
        if (path.endsWith("/compile")) {
          const id = request.headers.get("X-Compilation-Id");
          assert(id);
          compileJobs.set(id, path);
          return Response.json(
            { id, status: "queued", revision: 1, sourceRevision: 1 },
            { status: 202 },
          );
        }
        if (path.includes("/jobs/"))
          return Response.json({
            id: path.split("/").at(-1),
            status: "failed",
            error: "Fixture diagnostic",
            log: "main.tex:3: Undefined control sequence.",
          });
        if (path.endsWith("/events"))
          return new Response(
            `data: ${JSON.stringify({ revision: 0, current: null, latestBuild: null, stale: false, artifacts: null })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
        if (path.endsWith("/pdf")) return new Response(null, { status: 404 });
        return Response.json({
          revision: 0,
          current: null,
          latestBuild: null,
          stale: false,
          artifacts: null,
        });
      },
    },
  }),
  port,
  resourcePersistencePath: directory,
});
const cookies = new Map<string, string>();
async function actor(id: string) {
  await db.insert(user).values({
    id,
    name: "Assistant fixture",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const token = crypto.randomUUID();
  await db.insert(session).values({
    id: crypto.randomUUID(),
    userId: id,
    token,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  cookies.set(
    id,
    `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  );
  const created = await createProject({
    db,
    ownerId: id,
    data: { id: crypto.randomUUID(), name: "Assistant test" },
  });
  projectIds.push(created.id);
  return created.id;
}
async function send(path: string, id: string, method = "GET", body?: unknown) {
  return mf.dispatchFetch(`${origin}${path}`, {
    method,
    headers: {
      Cookie: cookies.get(id) ?? "",
      Origin: origin,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function chatBody(modelId = model.id) {
  return {
    threadId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Change Original text to Revised text and compile.",
      },
    ],
    tools: [],
    context: [],
    forwardedProps: { model: modelId },
  };
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await Bun.sleep(50);
  }
}
const browser = await chromium.launch({ headless: true });
try {
  await mf.ready;
  const paidProject = await actor(userId);
  const freeProject = await actor(freeId);
  await db.insert(subscription).values({
    id: subscriptionId,
    referenceId: userId,
    plan: "pro",
    status: "active",
    stripeCustomerId: "cus_pro",
    stripeSubscriptionId: "sub_pro",
  });
  objectKey = `projects/${paidProject}/sources/${sourceHash}`;
  const bucket = await mf.getR2Bucket("SOURCES");
  await bucket.put(objectKey, source);
  await db
    .update(projectNode)
    .set({
      objectKey,
      sizeBytes: BigInt(new TextEncoder().encode(source).length),
    })
    .where(
      and(eq(projectNode.projectId, paidProject), eq(projectNode.kind, "text")),
    );
  const path = `/api/ai/${paidProject}`;
  assert.equal(
    (await send(`/api/ai/${freeProject}`, freeId, "POST", chatBody())).status,
    403,
  );
  assert.equal((await send(path, freeId, "POST", chatBody())).status, 404);
  assert.equal((await mf.dispatchFetch(`${origin}${path}`)).status, 401);
  assert.equal(inference.length, 0, "denied requests never reach the model");
  for (const endpoint of ["get-access-token", "refresh-token"]) {
    assert.equal(
      (await send(`/api/auth/${endpoint}`, userId, "POST", {})).status,
      404,
    );
  }
  assert.equal((await send(path, userId)).status, 200);
  assert.equal(
    (
      await send(path, userId, "PATCH", {
        defaultModel: "@cf/test/second",
        monthlyCapDollars: 25,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await send(path, userId, "PATCH", {
        defaultModel: "invalid",
        monthlyCapDollars: 25,
      })
    ).status,
    400,
  );
  const firstThreadResponse = await send(`${path}?threads=1`, userId, "POST", {
    kind: "create",
  });
  assert.equal(firstThreadResponse.status, 200);
  const firstThread = threadHistorySchema.parse(
    await firstThreadResponse.json(),
  );
  const body = { ...chatBody(), threadId: firstThread.thread.id };
  const response = await send(path, userId, "POST", body);
  assert.equal(response.status, 200, await response.clone().text());
  const stream = await response.text();
  assert(stream.includes("TEXT_MESSAGE_CONTENT"), stream);
  assert(!stream.includes("RUN_ERROR"), stream);
  await eventually(
    async () =>
      (
        await db
          .select()
          .from(aiRequest)
          .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
          .where(eq(aiRun.clientRunId, body.runId))
      ).every((r) => r.ai_request.status === "reported"),
    "successful run bills",
  );
  const savedHistory = threadHistorySchema.parse(
    await (
      await send(`${path}?threads=1&thread=${body.threadId}`, userId)
    ).json(),
  );
  assert(savedHistory.messages.some((message) => message.role === "user"));
  assert(
    savedHistory.messages.some((message) =>
      message.parts.some((part) => part.type === "tool-call"),
    ),
    "tool calls survive server hydration",
  );
  assert(
    savedHistory.messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "text" && part.content.includes("Updated main.tex"),
      ),
    ),
  );
  const otherProject = await createProject({
    db,
    ownerId: userId,
    data: { id: crypto.randomUUID(), name: "Other assistant project" },
  });
  projectIds.push(otherProject.id);
  assert.equal(
    (
      await send(
        `/api/ai/${otherProject.id}?threads=1&thread=${body.threadId}`,
        userId,
      )
    ).status,
    404,
    "threads are isolated by project",
  );
  assert.equal(
    (
      await send(`${path}?threads=1`, userId, "POST", {
        kind: "rename",
        id: body.threadId,
        title: "Saved conversation",
      })
    ).status,
    200,
  );
  const list = z
    .object({ threads: z.array(threadSchema) })
    .parse(await (await send(`${path}?threads=1`, userId)).json());
  assert.equal(
    list.threads.find((thread) => thread.id === body.threadId)?.title,
    "Saved conversation",
  );
  assert.equal(inference.length, 6);
  assert.equal(meterEvents.length, 6);
  assert.equal(
    logCalls,
    6,
    "every inference request is priced from its own Gateway log",
  );
  assert(
    JSON.stringify(inference.at(-1)?.body).includes(
      "Undefined control sequence",
    ),
    "compile diagnostics reach the agent's next model turn",
  );
  assert.equal(compileJobs.size, 1);
  const nodes = await db.query.projectNode.findMany({
    where: { projectId: paidProject, kind: "text" },
  });
  const main = nodes.find((n) => n.name === "main.tex");
  assert(main?.objectKey);
  const saved = await bucket.get(main.objectKey);
  assert(saved);
  assert((await saved.text()).includes("Revised text."));
  assert.equal(
    (await send(path, userId, "POST", body)).status,
    409,
    "a duplicate run never repeats inference",
  );
  const git = new GitRepository();
  await git.init("https://github.com/fixture/project.git");
  git.overlay({ "main.tex": new TextEncoder().encode(source) });
  const initialCommit = await git.commit("Initial version", {
    name: "Test",
    email: "test@example.com",
  });
  const gitKey = `git/${paidProject}/fixture.json`;
  await bucket.put(gitKey, git.serialize());
  await db.insert(projectGit).values({
    projectId: paidProject,
    provider: "github",
    url: "https://github.com/fixture/project.git",
    objectKey: gitKey,
  });
  mode = "simple";
  const generated = await send(`${path}?git-message=1`, userId, "POST", {});
  assert.equal(generated.status, 200, await generated.clone().text());
  assert(
    z.object({ message: z.string().min(1) }).parse(await generated.json())
      .message,
  );
  const generationCall = inference.at(-1);
  assert(
    generationCall &&
      !JSON.stringify(generationCall.body).includes('"name":"git_commit"'),
    "message generation has no mutation tools",
  );
  const [linkedGit] = await db
    .select()
    .from(projectGit)
    .where(eq(projectGit.projectId, paidProject));
  assert.equal(linkedGit?.objectKey, gitKey, "generation does not commit");
  assert.equal((await git.status()).commits[0]?.oid, initialCommit);
  assert.equal(
    (await send(`/api/ai/${freeProject}?git-message=1`, freeId, "POST", {}))
      .status,
    403,
  );
  mode = "error";
  const failedMessage = await send(`${path}?git-message=1`, userId, "POST", {});
  assert.equal(
    failedMessage.status,
    503,
    "failed generation reports an error instead of suggesting a partial message",
  );
  const failureThread = threadHistorySchema.parse(
    await (
      await send(`${path}?threads=1`, userId, "POST", { kind: "create" })
    ).json(),
  );
  const failure = { ...chatBody(), threadId: failureThread.thread.id };
  const failed = await send(path, userId, "POST", failure);
  const failureStream = await failed.text();
  assert(failureStream.includes("RUN_ERROR"), failureStream);
  const [failureRun] = await db
    .select()
    .from(aiRun)
    .where(eq(aiRun.clientRunId, failure.runId));
  assert(failureRun);
  const failureRunId = failureRun.id;
  await eventually(async () => {
    const [r] = await db
      .select()
      .from(aiRequest)
      .where(eq(aiRequest.runId, failureRunId));
    return r?.status === "reported";
  }, "provider errors still bill");
  mode = "simple";
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const cookie = cookies.get(userId);
  assert(cookie);
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: cookie.slice(cookie.indexOf("=") + 1),
      url: origin,
    },
  ]);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/project/${paidProject}`);
  await page
    .getByRole("toolbar", { name: "Right sidebar views" })
    .getByRole("button", { name: "Git", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("complementary", { name: "Agent history", exact: true })
      .count(),
    0,
    "History is hidden by default",
  );
  const gitPanel = page.locator('[data-testid="git-panel"]');
  await gitPanel.getByLabel("Current branch").waitFor();
  await gitPanel
    .getByRole("button", { name: "Review diff", exact: true })
    .click();
  await gitPanel.getByLabel("Working tree diff").waitFor();
  await gitPanel
    .getByRole("button", { name: "Generate message · Pro", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>(
        '[data-testid="git-panel"] textarea',
      )?.value.length,
  );
  assert(await gitPanel.getByLabel("Commit message").inputValue());
  assert.equal(
    (
      await db
        .select()
        .from(projectGit)
        .where(eq(projectGit.projectId, paidProject))
    )[0]?.objectKey,
    gitKey,
    "UI generation leaves history unchanged",
  );
  const gitScreenshots = new URL("../../../.audit/nat-267/", import.meta.url)
    .pathname;
  await mkdir(gitScreenshots, { recursive: true });
  await page.screenshot({
    path: join(gitScreenshots, "git-connected-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close assistant", exact: true })
    .click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForFunction(
    () =>
      !!document.querySelector<HTMLTextAreaElement>(
        '[data-testid="git-panel"] textarea',
      )?.value.length,
  );
  await gitPanel.getByLabel("Commit message").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(gitScreenshots, "git-connected-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close project sidebar", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("toolbar", { name: "Right sidebar views" })
    .getByRole("button", { name: "Git", exact: true })
    .click();
  await gitPanel.getByLabel("Commit message").fill("Save revised document");
  await gitPanel
    .getByRole("button", { name: "Commit changes", exact: true })
    .click();
  await gitPanel.getByText("Working tree is clean.", { exact: true }).waitFor();
  await gitPanel.getByLabel("New branch name").fill("ui-draft");
  await gitPanel.getByRole("button", { name: "Create", exact: true }).click();
  await gitPanel.getByLabel("Current branch").selectOption("ui-draft");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="git-panel"] option:checked')
        ?.textContent === "ui-draft",
  );
  await gitPanel
    .getByRole("button", { name: "Unlink repository", exact: true })
    .click();
  await gitPanel
    .getByRole("button", { name: "Unlink remote", exact: true })
    .click();
  await gitPanel.getByLabel("Repository URL").waitFor();
  assert.equal(
    (
      await db
        .select()
        .from(projectGit)
        .where(eq(projectGit.projectId, paidProject))
    ).length,
    0,
  );
  console.info("Checking persistent assistant UI");
  await page.getByRole("button", { name: "Toggle agents sidebar" }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("button", { name: "Model for this chat" }).waitFor();
  await page
    .getByRole("textbox", { name: "Message the assistant" })
    .fill("Explain this project.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("log")
    .getByText("Updated main.tex and submitted a compile.")
    .waitFor();
  await page
    .getByRole("button", { name: "Retry message", exact: true })
    .click();
  await page
    .getByRole("log")
    .getByText("Updated main.tex and submitted a compile.")
    .waitFor();
  console.info("Checking Stop after retry");
  mode = "slow";
  await page
    .getByRole("textbox", { name: "Message the assistant" })
    .fill("Continue, then stop.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("log").getByText("Working…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const lastCall = inference.at(-1);
  assert(lastCall);
  const stoppedRunId = z
    .object({ runId: z.uuid() })
    .parse(JSON.parse(lastCall.headers.get("cf-aig-metadata") ?? "{}")).runId;
  await eventually(async () => {
    const [run] = await db
      .select()
      .from(aiRun)
      .where(eq(aiRun.id, stoppedRunId));
    const requests = await db
      .select()
      .from(aiRequest)
      .where(eq(aiRequest.runId, stoppedRunId));
    return (
      run?.status === "aborted" &&
      requests.length === 1 &&
      requests[0]?.status === "reported"
    );
  }, "Stop aborts the provider stream and still bills its usage");
  mode = "simple";
  await page.locator("aside details").first().locator("summary").click();
  await page
    .getByRole("spinbutton", { name: "Monthly AI spend cap" })
    .fill("0");
  await page.getByRole("button", { name: "Save AI preferences" }).click();
  await page.getByText("AI preferences saved.", { exact: true }).waitFor();
  assert(
    await page
      .getByRole("textbox", { name: "Message the assistant" })
      .isDisabled(),
  );
  await page
    .getByRole("spinbutton", { name: "Monthly AI spend cap" })
    .fill("25");
  await page.getByRole("button", { name: "Save AI preferences" }).click();
  await eventually(
    async () =>
      !(await page
        .getByRole("textbox", { name: "Message the assistant" })
        .isDisabled()),
    "restoring the cap resumes chat",
  );
  await page.locator("aside details").first().locator("summary").click();
  await page.getByRole("button", { name: "Model for this chat" }).click();
  await page
    .getByRole("menuitemradio", { name: "Fixture model", exact: true })
    .click();
  console.info("Checking per-chat model override and new chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await page
    .getByRole("button", { name: "Model for this chat" })
    .getByText("Second model", { exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Message the assistant" })
    .fill("Explain this project.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("log")
    .getByText("Updated main.tex and submitted a compile.")
    .waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await page.reload();
  await page
    .getByRole("log")
    .getByText("Updated main.tex and submitted a compile.")
    .waitFor();
  await page
    .getByRole("button", { name: "Toggle chat history", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Agent history", exact: true })
    .waitFor();
  const historyLayout = await page.evaluate(() => {
    const history = document.querySelector('[aria-label="Agent history"]');
    const agents = document.querySelector('[aria-label="AI assistant"]');
    const editor = document.querySelector(".cm-editor");
    if (!history || !agents || !editor) throw new Error("Missing agent layout");
    return {
      history: history.getBoundingClientRect().x,
      agents: agents.getBoundingClientRect().x,
      editor: editor.getBoundingClientRect().x,
    };
  });
  assert(
    historyLayout.history < historyLayout.agents &&
      historyLayout.agents < historyLayout.editor,
    "History is a separate pane to the left of Agents",
  );

  assert(
    await page
      .getByRole("navigation", { name: "Chat history" })
      .getByRole("button")
      .count(),
  );
  const finalThreads = await db
    .select()
    .from(aiThread)
    .where(eq(aiThread.projectId, paidProject));
  assert(finalThreads.length >= 4);
  const disposable = threadHistorySchema.parse(
    await (
      await send(`${path}?threads=1`, userId, "POST", { kind: "create" })
    ).json(),
  );
  assert.equal(
    (
      await send(`${path}?threads=1`, userId, "POST", {
        kind: "delete",
        id: disposable.thread.id,
      })
    ).status,
    200,
  );
  assert.equal(
    (await send(`${path}?threads=1&thread=${disposable.thread.id}`, userId))
      .status,
    404,
  );
  assert.equal(
    (
      await db
        .select()
        .from(aiMessage)
        .where(eq(aiMessage.threadId, disposable.thread.id))
    ).length,
    0,
  );
  await page
    .getByRole("button", { name: /^Manage chat / })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Chat name" })
    .fill("Reviewed thread");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Chat history" })
    .getByRole("button", { name: "Reviewed thread", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("navigation", { name: "Chat history" })
    .getByRole("button", { name: "Reviewed thread", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Manage chat Reviewed thread", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reviewed thread", exact: true })
    .waitFor({ state: "detached" });
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Model for this chat", exact: true })
    .waitFor();
  await page
    .getByRole("navigation", { name: "Chat history" })
    .getByRole("button", { name: "Saved conversation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Model for this chat", exact: true })
    .waitFor();
  assert(
    await page.locator('[data-slot="trace"]').count(),
    "saved tool calls use the structured Tool pattern",
  );
  const screenshots = new URL(
    "../../../.audit/nat-314/assistant/",
    import.meta.url,
  ).pathname;
  await mkdir(screenshots, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: join(screenshots, "assistant-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("complementary", { name: "AI assistant", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Toggle agents sidebar", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "AI assistant", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(screenshots, "assistant-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.info(
    `AI assistant and metered git commit messages passed: authenticated Worker SSE, server file tools, collaborative edits, compile tool, metering every call, provider errors, default model, duplicate run rejection, Free denial, and desktop/mobile UI. Screenshots: ${screenshots}`,
  );
} finally {
  await browser.close();
  await mf.dispose();
  const runs = await db
    .select({ id: aiRun.id })
    .from(aiRun)
    .where(eq(aiRun.userId, userId));
  if (runs.length) {
    await db.delete(aiRequest).where(
      inArray(
        aiRequest.runId,
        runs.map((r) => r.id),
      ),
    );
    await db.delete(aiRun).where(eq(aiRun.userId, userId));
  }
  await db.delete(subscription).where(eq(subscription.id, subscriptionId));
  if (projectIds.length)
    await db.delete(project).where(inArray(project.id, projectIds));
  await db.delete(user).where(inArray(user.id, [userId, freeId]));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
