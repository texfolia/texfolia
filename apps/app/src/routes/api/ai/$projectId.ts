import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { aiConfig } from "#/features/ai/ai-config.server";
import { assistantWorkspace } from "#/features/ai/assistant.server";
import { gatewayRequestCost } from "#/features/ai/gateway";
import {
  aiAccess,
  aiErrorResponse,
  assistantConfiguration,
  checkAiOrigin,
  listAssistantThreads,
  manageAssistantThread,
  readAiBody,
  readAssistantThread,
  startAssistant,
  updateAiPreferences,
} from "#/features/ai/server";
import { createAuth } from "#/features/auth/auth";
import { reconcileAiUsage } from "#/features/billing/server";
import { lockProject } from "#/features/sharing/project-access.server";

export const Route = createFileRoute("/api/ai/$projectId")({
  server: {
    handlers: {
      GET: async ({ request, params, context }) => {
        try {
          const { userId } = await aiAccess({
            request,
            projectId: params.projectId,
            db: context.db,
            auth: context.auth,
            lock: lockProject,
          });
          const url = new URL(request.url);
          if (url.searchParams.has("threads")) {
            const id = url.searchParams.get("thread");
            if (id && !z.uuid().safeParse(id).success)
              return Response.json(
                { error: "Chat not found." },
                { status: 404 },
              );
            return Response.json(
              id
                ? await readAssistantThread(
                    context.db,
                    params.projectId,
                    userId,
                    id,
                  )
                : {
                    threads: await listAssistantThreads(
                      context.db,
                      params.projectId,
                      userId,
                    ),
                  },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
          return Response.json(
            await assistantConfiguration({
              db: context.db,
              userId,
              config: aiConfig(),
            }),
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          return aiErrorResponse(error);
        }
      },
      PATCH: async ({ request, params, context }) => {
        try {
          checkAiOrigin(request);
          const { userId } = await aiAccess({
            request,
            projectId: params.projectId,
            db: context.db,
            auth: context.auth,
            lock: lockProject,
          });
          return Response.json(
            await updateAiPreferences({
              db: context.db,
              userId,
              body: await readAiBody(request),
              config: aiConfig(),
            }),
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          return aiErrorResponse(error);
        }
      },
      POST: async ({ request, params, context }) => {
        try {
          checkAiOrigin(request);
          const access = await aiAccess({
            request,
            projectId: params.projectId,
            db: context.db,
            auth: context.auth,
            lock: lockProject,
          });
          if (new URL(request.url).searchParams.get("reconcile") === "1") {
            const config = aiConfig();
            await reconcileAiUsage({
              db: context.db,
              config,
              requestCost: gatewayRequestCost(config),
              userId: access.userId,
            });
            return Response.json(
              await assistantConfiguration({
                db: context.db,
                userId: access.userId,
                config,
              }),
              { headers: { "Cache-Control": "no-store" } },
            );
          }
          if (new URL(request.url).searchParams.has("threads")) {
            return Response.json(
              await manageAssistantThread(
                context.db,
                params.projectId,
                access.userId,
                await readAiBody(request),
              ),
              { headers: { "Cache-Control": "no-store" } },
            );
          }
          return await startAssistant({
            request,
            projectId: params.projectId,
            connectionString: env.HYPERDRIVE.connectionString,
            createAuth: (db) => createAuth(db),
            workspace: assistantWorkspace(env),
            ...access,
            body: await readAiBody(request),
            config: aiConfig(),
            purpose:
              new URL(request.url).searchParams.get("git-message") === "1"
                ? "commit-message"
                : undefined,
          });
        } catch (error) {
          return aiErrorResponse(error);
        }
      },
    },
  },
});
