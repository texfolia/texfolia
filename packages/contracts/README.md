# Contracts

Schemas, types and constants that more than one app uses. The product app and
the compiler share the root entry:

- [`paths.ts`](src/paths.ts): the source, artifact and node name path policy.
- [`telemetry.ts`](src/telemetry.ts): plans, engines, and engine, job and
  browser preview timing.
- [`builds.ts`](src/builds.ts): compile job responses and the build snapshot.

The product app and the marketing site share two zod-free entries:

- [`hosts.ts`](src/hosts.ts) (`@texfolia/contracts/hosts`): where each app is
  served.
- [`plans.ts`](src/plans.ts) (`@texfolia/contracts/plans`): public plan names and
  monthly prices.

The package has no runtime dependencies besides its `zod` peer. Each app
extends these schemas with fields it keeps to itself, such as the compiler's
stored job fields.

The Go engine cannot import TypeScript. Its path policy is checked against
[`fixtures/path-policy.json`](fixtures/path-policy.json), which this package's
tests and `apps/compiler/engine/path_policy_test.go` both read.
