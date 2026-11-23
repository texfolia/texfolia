# Git integrations

Git integrations for the product app. Texfolia does not host Git (see
[Git integration](../../../../../docs/git-integration.md)): every action runs against a
remote linked on an integrated platform. The project's working clone is kept
in R2 as a cache that holds unpushed commits.

| Entry point              | Contents                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/features/git`         | Client-safe. Actions: `gitActionSchema` and `GitAction` (status, diff, fetch, link, import, unlink, commit, push, pull, branch, checkout), `GitStatus`, `GitResult`. Remote URLs: `gitRemoteSchema`, `gitRemoteMessage`, `gitBranchSchema`. Provider registry: `gitProviders`, `gitProvider`, `gitProviderForHost`, `gitProviderIds`, `isGitProvider`, `hasRepositoryAccess`, `gitHostsLabel` |
| `#/features/git/server`  | `runGit` (one action against the linked remote), `gitBranch` (cached branch for the status bar), `gitAccounts` and `gitAccount` (connected OAuth accounts), `collectGitObjects` (R2 cleanup), and the lower-level `GitRepository` and `gitHttp`                                                                                                                                               |
| `#/features/git/testing` | Bun test helpers: `gitServer` (a local `git http-backend` smart HTTP server) and `gitCommand`                                                                                                                                                                                                                                                                                                 |

Other features import only these entry points; the remaining files are private.

## Boundaries

The feature depends on `@texfolia/db` (`project_git`, project nodes, accounts),
`#/features/storage` (source objects), `#/features/projects` (paths and the
`LockProject` type) and `@texfolia/auth/roles`. It does not know about share
links, Better Auth sessions, Durable Objects, or server functions. The app
passes those in:

- `lock` locks the project row and checks access (`runGit`, `gitBranch`).
- `accessToken` exchanges the user's linked account for an OAuth token
  (`runGit`). `gitAccount` finds the account and checks its scopes.

The app binds both in `apps/app/src/lib/git.server.ts`. The server functions
(`git.functions.ts`), the `gitAction` method on the `ProjectCollaboration`
Durable Object, the remote form, the workspace Git panel and status bar, the
assistant's Git tools, and Settings → Connections stay outside the feature.

## Adding a platform

Write an adapter in `providers/` with `defineGitProvider`, register it in
`gitProviders`, and add its Better Auth social provider in `packages/auth`. Do
not fork the core module; add an adapter field if the platform's Git HTTP
differs.

## Checks

```sh
bun test apps/app/src/features/git
```

`test` needs `git` with `git-http-backend` on `PATH`. The Worker, R2 and
collaboration path is covered by `bun run --cwd apps/app test:git`, which needs
`INTEGRATION_DATABASE_URL`.
