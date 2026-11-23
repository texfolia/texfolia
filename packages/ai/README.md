# @texfolia/ai

The managed LaTeX assistant: chat runs on Cloudflare AI Gateway through TanStack
AI, the tools the model can call on a project, saved threads, agent skills, and
the assistant panel. See [Configure the managed assistant](../../docs/ai-assistant.md).

| Entry point            | Contents                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texfolia/ai`         | Client-safe contracts. Configuration: `aiConfigurationSchema`, `aiModelSchema`, `aiPreferencesSchema`, `maxOutputTokens`. Threads: `threadSchema`, `threadHistorySchema`, `threadActionSchema`, `storedMessageSchema`. `AiError` (a refusal with an HTTP status)                                                                                                                                    |
| `@texfolia/ai/server`  | Chat: `aiAccess` (session, project access, and payer), `startAssistant` (streamed runs and Git commit messages), `assistantConfiguration`, `updateAiPreferences`, and the request helpers `checkAiOrigin`, `readAiBody`, `aiErrorResponse`. Tools: `projectTools`. Threads: `listAssistantThreads`, `readAssistantThread`, `manageAssistantThread`. Types: `AssistantWorkspace`, `AssistantContext` |
| `@texfolia/ai/gateway` | Server-only AI Gateway access without the chat stack: `parseAiConfig`, `gatewayModels` (the catalog), `gatewayRequestCost` (prices for reconciliation), and the `AiConfig` and `AiFetch` types                                                                                                                                                                                                      |
| `@texfolia/ai/ui`      | `AssistantSidebar` (the chat panel and its history list) and the primitives it uses: `ModelSelector`, `PromptInput`, `Reasoning`, `Sources`, `Suggestion`, `Tool`                                                                                                                                                                                                                                   |

Import only these entry points; `src/` paths are private. Load
`@texfolia/ai/server` and `@texfolia/ai/gateway` only on the server.

## Boundaries

The package depends on `@texfolia/db` (threads, messages, runs, preferences),
`@texfolia/billing` (entitlements, reservations, reconciliation),
`@texfolia/projects` (paths, search), `@texfolia/git` (branch and action
schemas), `@texfolia/compile` (log parsing), `@texfolia/storage` (source
encoding), `@texfolia/auth` (the session type), and `@texfolia/ui`.

Usage metering stays in `@texfolia/billing`. This package reserves each model
request before sending it and supplies `gatewayRequestCost`, the price lookup
that `reconcileAiUsage` takes.

The caller passes in the rest:

- `workspace`: an `AssistantWorkspace`, which holds the project lock and the
  node, source, Git, and compile operations. Each operation checks access itself.
  The app builds it in `apps/app/src/lib/assistant.server.ts`.
- `config`: the Gateway and meter settings, checked by `parseAiConfig`. The app
  reads the secrets in `apps/app/src/lib/ai-config.server.ts`.
- `connectionString` and `createAuth`: `startAssistant` opens its own database
  client, because the reply stream outlives the request handler, and rechecks
  the session before every model request.
- `endpoint`, `plansUrl`, sizes, and the history resize handle:
  `AssistantSidebar` knows nothing about the workspace layout or app routes.

`list_skills` finds skills and `AGENTS.md` files; their bodies enter the context
only when the model reads them.

The `/api/ai` route, the scheduled reconciler, account AI settings, and the
workspace panel stay in `apps/app`. A consuming app must add `packages/ai/src/ui`
to its Tailwind sources, as `apps/app/src/styles.css` does.

## Checks

```sh
bun run --cwd packages/ai test
bun run --cwd packages/ai typecheck
```

Integration coverage is in `apps/app`: `test:ai-assistant`, `test:ai-billing`, and
`test:compile-route` (the assistant's compile tool).
