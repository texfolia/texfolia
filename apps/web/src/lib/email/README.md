# Email

Email messages and delivery. The feature depends on no other feature and has no
access to bindings or secrets; callers pass them in.

- **Messages:** `codeEmail`, `invitationEmail`, `projectCollaboratorEmail`,
  `projectShareLinkEmail`, and `deleteAccountEmail` build the subject, text,
  and HTML. `#/lib/auth/auth` sends auth and organization messages;
  `#/lib/sharing` sends project collaborator and share-link messages.
- **Delivery:** `sendEmail` sends an `EmailMessage` from `EMAIL_FROM` through the
  Worker's `send_email` binding. Auth and organization messages use it directly.
  `createEmailDelivery` puts an `EmailJob` on the `background` queue instead, so
  sharing requests don't wait for delivery; `handleBuildQueue` sends it.

```sh
bun test apps/app/src/lib/email
```
