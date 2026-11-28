# @texfolia/tsconfig

`@texfolia/tsconfig` holds the TypeScript settings that every workspace extends.

| Config                | Used by                                                        |
| --------------------- | -------------------------------------------------------------- |
| `base.json`           | The other configs, and `apps/docs` (Next.js + Fumadocs)        |
| `bun.json`            | `apps/compiler`, `packages/contracts`, `packages/db`, the root |
| `react-library.json`  | React workspace libraries                                      |
| `tanstack-start.json` | `apps/app`, `apps/web`                                         |

Add the package to `devDependencies` and extend a config:

```json
{
  "extends": "@texfolia/tsconfig/bun.json"
}
```

Keep `paths`, `include`, and `exclude` in the workspace's own `tsconfig.json`.
Each workspace also installs the packages that its `types` name.
