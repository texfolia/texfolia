# @texfolia/email

Email messages and delivery. The package has no dependencies and no access to
bindings or secrets.

- **Messages:** `codeEmail`, `invitationEmail`, and `deleteAccountEmail` build
  the subject, text, and HTML. `@texfolia/auth` sends them.
- **Delivery:** `sendEmail` sends an `EmailMessage` through the Worker's
  `send_email` binding. `apps/app` passes its `EMAIL` binding in
  `src/features/auth/auth.ts`.

```sh
bun run --cwd packages/email test
bun run --cwd packages/email typecheck
```
