# Git integrations

Git integrations for the product app. Texfolia does not host Git (see
[Git integration](../../../../../docs/git-integration.md)): every action runs against a
remote linked on an integrated platform. The project's working clone is kept
in R2 as a cache that holds unpushed commits.

| Entry point         | Contents                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/git`         | Client-safe. Actions: `gitActionSchema` and `GitAction` (status, diff, fetch, link, import, unlink, commit, push, pull, branch, checkout), `GitStatus`, `GitResult`. Remote URLs: `gitRemoteSchema`, `gitRemoteMessage`, `gitBranchSchema`. Provider registry: `gitProviders`, `gitProvider`, `gitProviderForHost`, `gitProviderIds`, `isGitProvider`, `hasRepositoryAccess`, `gitHostsLabel` |
| `#/lib/git/server`  | `runGit` (one action against the linked remote), `gitBranch` (cached branch for the status bar), `gitVersion` (metadata poll signal), `gitAccounts` and `gitAccount` (connected OAuth accounts), `collectGitObjects` (R2 cleanup), and the lower-level `GitRepository` and `gitHttp`                                                                                                          |
| `#/lib/git/testing` | Bun test helpers: `gitServer` (a local `git http-backend` smart HTTP server) and `gitCommand`                                                                                                                                                                                                                                                                                                 |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path.

## Boundaries

The feature depends on `@texfolia/db` (`project_git`, project nodes, accounts),
`#/lib/storage` (source objects), `#/lib/projects` (paths and the
`LockProject` type) and `#/lib/auth/roles`. The core does not know about
share links, Better Auth sessions, Durable Objects, or server functions. It takes
those as arguments:

- `lock` locks the project row and checks access (`runGit`, `gitBranch`).
- `accessToken` exchanges the user's linked account for an OAuth token
  (`runGit`). `gitAccount` finds the account and checks its scopes.

`git.server.ts` binds both, and `git.functions.ts` has the server functions. The `gitAction` method on the `ProjectCollaboration`
Durable Object, the remote form, the workspace Git panel and status bar, the
assistant's Git tools, and Settings → Connections stay outside the feature.

## Adding a platform

Write an adapter in `providers/` with `defineGitProvider`, register it in
`gitProviders`, and add its Better Auth social provider in `#/lib/auth/auth`. Do
not fork the core module; add an adapter field if the platform's Git HTTP
differs.

## Checks

```sh
bun test apps/app/src/lib/git
```

`test` needs `git` with `git-http-backend` on `PATH`. The Worker, R2 and
collaboration path is covered by `bun run --cwd apps/app test:git`, which needs
`INTEGRATION_DATABASE_URL`.
