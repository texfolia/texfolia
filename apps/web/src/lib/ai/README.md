# AI assistant

The managed LaTeX assistant: chat runs on Cloudflare AI Gateway through TanStack
AI, the tools the model can call on a project, saved threads, agent skills, and
the assistant panel. See [Configure the managed assistant](../../../../docs/content/docs/ai-assistant.md).

| Entry point        | Contents                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/ai`         | Client-safe contracts. Configuration: `aiConfigurationSchema`, `aiModelSchema`, `aiPreferencesSchema`, `maxOutputTokens`. Threads: `threadSchema`, `threadListSchema`, `threadHistorySchema`, `threadActionSchema`, `storedMessageSchema`. `AiError` (a refusal with an HTTP status)                                                                                                                |
| `#/lib/ai/server`  | Chat: `aiAccess` (session, project access, and payer), `startAssistant` (streamed runs and Git commit messages), `assistantConfiguration`, `updateAiPreferences`, and the request helpers `checkAiOrigin`, `readAiBody`, `aiErrorResponse`. Tools: `projectTools`. Threads: `listAssistantThreads`, `readAssistantThread`, `manageAssistantThread`. Types: `AssistantWorkspace`, `AssistantContext` |
| `#/lib/ai/gateway` | Server-only AI Gateway access without the chat stack: `parseAiConfig`, `gatewayModels` (the catalog, cached for ten minutes), `gatewayRequestCost` (prices for reconciliation), and the `AiConfig` and `AiFetch` types                                                                                                                                                                              |
| `#/lib/ai/ui`      | `AssistantSidebar` (the chat panel and its history list) and the primitives it uses: `ModelSelector`, `PromptInput`, `Reasoning`, `Sources`, `Suggestion`, `Tool`                                                                                                                                                                                                                                   |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path. Load
`#/lib/ai/server` and `#/lib/ai/gateway` only on the server.

## Boundaries

The feature depends on `@texfolia/db` (threads, messages, runs, preferences),
`#/lib/billing` (entitlements, reservations, reconciliation),
`#/lib/projects` (paths, search), `#/lib/git` (branch and action
schemas), `#/lib/compile` (log parsing), `#/lib/storage` (source
encoding), `#/lib/auth/auth` (the session type), and `#/components/ui`.

Usage metering stays in `#/lib/billing`. This feature reserves each model
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
- `waitUntil`: keeps the Worker running until a run is saved and settled, even when
  the client leaves.
- `editor`: an `AssistantEditor` (`editor.ts`), which lists and opens files, undoes
  changes, and hands over requests from the editor. The workspace's
  `use-assistant-editor` builds it. `revert.ts` reads the changes of tool calls
  and finds them in the current text.
- `endpoint`, `plansUrl`, sizes, and the history resize handle:
  `AssistantSidebar` knows nothing about the workspace layout or app routes.

`list_skills` finds skills and `AGENTS.md` files; their bodies enter the context
only when the model reads them.

The `/api/ai` route, the scheduled reconciler, account AI settings, and the
workspace panel stay outside the feature.

## Checks

```sh
bun test apps/app/src/lib/ai
```

Integration coverage is in `apps/app`: `test:ai-assistant`, `test:ai-billing`, and
`test:compile-route` (the assistant's compile tool).
