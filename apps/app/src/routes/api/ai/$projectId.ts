import { createFileRoute } from "@tanstack/react-router";
import { reconcileAiUsage } from "@texfolia/billing/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  aiAccess,
  aiErrorResponse,
  assistantConfiguration,
  checkAiOrigin,
  readAiBody,
  startAssistant,
  updateAiPreferences,
} from "#/lib/ai/chat.server";
import { aiConfig, gatewayRequestCost } from "#/lib/ai/gateway.server";
import {
  listAssistantThreads,
  readAssistantThread,
  manageAssistantThread,
} from "#/lib/ai/threads.server";

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
            await assistantConfiguration({ db: context.db, userId }),
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
          });
          return Response.json(
            await updateAiPreferences({
              db: context.db,
              userId,
              body: await readAiBody(request),
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
            env,
            ...access,
            body: await readAiBody(request),
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
