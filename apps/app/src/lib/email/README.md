# Email

Email messages and delivery. The feature has no dependencies and no access to
bindings or secrets.

- **Messages:** `codeEmail`, `invitationEmail`, `projectCollaboratorEmail`,
  `projectShareLinkEmail`, and `deleteAccountEmail` build the subject, text,
  and HTML. `#/lib/auth/auth` sends auth and organization messages;
  `#/lib/sharing` sends project collaborator and share-link messages.
- **Delivery:** `sendEmail` sends an `EmailMessage` through the Worker's
  `send_email` binding, and `createEmailDelivery` wraps an optional binding and
  base URL for feature server functions.

```sh
bun test apps/app/src/lib/email
```
