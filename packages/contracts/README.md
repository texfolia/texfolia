# Contracts

Zod schemas and types that the web app and the compiler both use:

- [`paths.ts`](src/paths.ts): the source, artifact and node name path policy.
- [`telemetry.ts`](src/telemetry.ts): plans, engines, and engine, job and
  browser preview timing.
- [`builds.ts`](src/builds.ts): compile job responses and the build snapshot.

The package has no runtime dependencies besides its `zod` peer. Each app
extends these schemas with fields it keeps to itself, such as the compiler's
stored job fields.

The Go engine cannot import TypeScript. Its path policy is checked against
[`fixtures/path-policy.json`](fixtures/path-policy.json), which this package's
tests and `apps/compiler/engine/path_policy_test.go` both read.
