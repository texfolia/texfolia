# Contributing

Thanks for your interest in Texfolia. The project is pre-release and isn't
accepting pull requests yet. Bug reports and feature ideas are welcome as
[issues](https://github.com/texfolia/texfolia/issues/new/choose).

## Run it locally

Follow the [quick start](../README.md#quick-start). In short:

```sh
bun install
bun run setup
bun run dev
```

Each app and package has a README with its own commands:
[app](../apps/app/README.md), [web](../apps/web/README.md),
[docs](../apps/docs/README.md), [compiler](../apps/compiler/README.md),
[contracts](../packages/contracts/README.md), [db](../packages/db/README.md),
[ui](../packages/ui/README.md) and [tsconfig](../packages/tsconfig/README.md).

## Before you push

```sh
bun run lint
bun run format:check
bun run typecheck
bun run test
```

CI also runs browser, database and engine suites for the areas a change
touches. Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org), such as
`fix(app): keep the cursor after a remote edit`.

By contributing, you agree that your work is licensed under the
[GNU General Public License v3.0](../LICENSE) and that you follow the
[code of conduct](CODE_OF_CONDUCT.md).
