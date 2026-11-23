# Email

Email messages and delivery. The feature has no dependencies and no access to
bindings or secrets.

- **Messages:** `codeEmail`, `invitationEmail`, and `deleteAccountEmail` build
  the subject, text, and HTML. `#/features/auth/server` sends them.
- **Delivery:** `sendEmail` sends an `EmailMessage` through the Worker's
  `send_email` binding. `#/features/auth/auth` passes the `EMAIL` binding.

```sh
bun test apps/app/src/features/email
```
