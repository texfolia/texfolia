# @texfolia/contracts

Schemas, types and constants that more than one app uses. The root entry holds:

- [`paths.ts`](src/paths.ts): the source, artifact and node name path policy.
- [`telemetry.ts`](src/telemetry.ts): plans, engines, and engine, job and
  browser preview timing.
- [`builds.ts`](src/builds.ts): compile job responses and the build snapshot,
  which the product app's server sends to its browser.

The product app and the compiler share one server-only entry:

- [`compiler.ts`](src/compiler.ts) (`@texfolia/contracts/compiler`): the compile
  wire in Effect Schema, with [`archive.ts`](src/archive.ts), its archive codec.
  The Go engine implements the same layout.

The product app and the marketing site share two zod-free entries:

- [`hosts.ts`](src/hosts.ts) (`@texfolia/contracts/hosts`): where each app is
  served.
- [`plans.ts`](src/plans.ts) (`@texfolia/contracts/plans`): public plan names and
  monthly prices.

The package has no runtime dependencies besides its `zod` peer, and an `effect`
peer for the compiler entry. The product app extends these schemas with fields
it keeps to itself, such as its stored job fields.

The Go engine cannot import TypeScript. Its path policy is checked against
[`fixtures/path-policy.json`](fixtures/path-policy.json), which this package's
tests and `apps/compiler/engine/path_policy_test.go` both read.

## Commands

```sh
bun run --cwd packages/contracts test
bun run --cwd packages/contracts typecheck
```
