# AI assistant

The managed LaTeX assistant: chat runs on Cloudflare AI Gateway through TanStack
AI, the tools the model can call on a project, saved threads, agent skills, and
the assistant panel. See [Configure the managed assistant](../../../../../docs/ai-assistant.md).

| Entry point             | Contents                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/features/ai`         | Client-safe contracts. Configuration: `aiConfigurationSchema`, `aiModelSchema`, `aiPreferencesSchema`, `maxOutputTokens`. Threads: `threadSchema`, `threadHistorySchema`, `threadActionSchema`, `storedMessageSchema`. `AiError` (a refusal with an HTTP status)                                                                                                                                    |
| `#/features/ai/server`  | Chat: `aiAccess` (session, project access, and payer), `startAssistant` (streamed runs and Git commit messages), `assistantConfiguration`, `updateAiPreferences`, and the request helpers `checkAiOrigin`, `readAiBody`, `aiErrorResponse`. Tools: `projectTools`. Threads: `listAssistantThreads`, `readAssistantThread`, `manageAssistantThread`. Types: `AssistantWorkspace`, `AssistantContext` |
| `#/features/ai/gateway` | Server-only AI Gateway access without the chat stack: `parseAiConfig`, `gatewayModels` (the catalog), `gatewayRequestCost` (prices for reconciliation), and the `AiConfig` and `AiFetch` types                                                                                                                                                                                                      |
| `#/features/ai/ui`      | `AssistantSidebar` (the chat panel and its history list) and the primitives it uses: `ModelSelector`, `PromptInput`, `Reasoning`, `Sources`, `Suggestion`, `Tool`                                                                                                                                                                                                                                   |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path. Load
`#/features/ai/server` and `#/features/ai/gateway` only on the server.

## Boundaries

The feature depends on `@texfolia/db` (threads, messages, runs, preferences),
`#/features/billing` (entitlements, reservations, reconciliation),
`#/features/projects` (paths, search), `#/features/git` (branch and action
schemas), `#/features/compile` (log parsing), `#/features/storage` (source
encoding), `@texfolia/auth` (the session type), and `@texfolia/ui`.

Usage metering stays in `#/features/billing`. This feature reserves each model
request before sending it and supplies `gatewayRequestCost`, the price lookup
that `reconcileAiUsage` takes.

The core takes the rest as arguments:

- `workspace`: an `AssistantWorkspace`, which holds the project lock and the
  node, source, Git, and compile operations. Each operation checks access itself.
  `assistant.server.ts` builds it.
- `config`: the Gateway and meter settings, checked by `parseAiConfig`. `ai-config.server.ts`
  reads the secrets.
- `connectionString` and `createAuth`: `startAssistant` opens its own database
  client, because the reply stream outlives the request handler, and rechecks
  the session before every model request.
- `endpoint`, `plansUrl`, sizes, and the history resize handle:
  `AssistantSidebar` knows nothing about the workspace layout or app routes.

`list_skills` finds skills and `AGENTS.md` files; their bodies enter the context
only when the model reads them.

The `/api/ai` route, the scheduled reconciler, account AI settings, and the
workspace panel stay outside the feature.

## Checks

```sh
bun test apps/app/src/features/ai
```

Integration coverage is in `apps/app`: `test:ai-assistant`, `test:ai-billing`, and
`test:compile-route` (the assistant's compile tool).
