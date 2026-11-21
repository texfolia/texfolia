import { createFileRoute } from "@tanstack/react-router";

import {
  PolicyLayout,
  type PolicySection,
  ToBeCompleted,
} from "#/components/policy-layout";
import { pageHead } from "#/lib/head";
import { appPath } from "#/lib/urls";

const accountSettings = appPath("/settings/account");

const sections: PolicySection[] = [
  {
    id: "operator",
    title: "Operator and contact",
    body: (
      <>
        <p>
          Texfolia is an online LaTeX workspace for editing documents,
          collaborating, compiling PDFs, and using a managed AI assistant.
        </p>
        <ToBeCompleted>
          Add the legal operator name, location, monitored privacy contact, and
          effective date.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts and sign-in",
    body: (
      <>
        <p>
          Account records include your name, email address, verification status,
          profile image when supplied, and account timestamps. Connected sign-in
          providers can supply account identifiers and authentication tokens.
          Sessions use cookies and can record your IP address, browser
          information, and an expiry time.
        </p>
        <p>
          Sign-in and account-verification messages are sent by email.
          Cloudflare Turnstile checks email-code requests to help prevent abuse.
        </p>
      </>
    ),
  },
  {
    id: "projects",
    title: "Projects and collaboration",
    body: (
      <>
        <p>
          Texfolia stores project names, file names, folder structure, saved
          text, uploaded files, and access permissions. Saved sources are
          processed to produce PDFs, compilation logs, and generated files. Live
          collaboration stores synchronized document state and shares presence
          and cursor information.
        </p>
        <p>
          People with project access can see its files and the names, email
          addresses, and roles shown in the collaboration panel.
          Personal-project owners manage sharing with existing accounts;
          organization projects use organization membership for access.
        </p>
      </>
    ),
  },
  {
    id: "publishing-and-git",
    title: "Published templates and Git",
    body: (
      <>
        <p>
          Publishing a template creates a separate snapshot of saved files for
          review. Approved public templates appear in the gallery. Approved
          unlisted templates are accessible to anyone with their URL. Downloads
          and project copies are independent of the original project.
        </p>
        <p>
          Optional Git history stores repository data on Texfolia. Git commits
          record author names and email addresses. Connecting a GitHub or GitLab
          repository uses provider credentials; pushing sends committed files
          and history to that host. Unlinking discards Texfolia's repository
          data and keeps current project files. Remote copies follow the host's
          policies.
        </p>
      </>
    ),
  },
  {
    id: "assistant",
    title: "The AI assistant",
    body: (
      <>
        <p>
          Using the assistant sends messages, conversation context, and project
          content read by its tools through Cloudflare AI Gateway to the
          selected model service. Tools can read and edit saved text, compile
          documents, and work with the project's Git repository. File edits are
          saved and shared with collaborators immediately.
        </p>
        <p>
          Chats are saved on the server for each user and project. Saved content
          includes messages, tool calls and results, and model reasoning when
          returned. Individual chats can be deleted from chat history. Separate
          billing records store model usage, costs, timestamps, identifiers, and
          the original payer.
        </p>
        <ToBeCompleted>
          Confirm the selected model services' retention and training practices
          and the final disclosures about AI processing.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "providers",
    title: "Storage, payments, and service records",
    body: (
      <>
        <p>
          Account and project metadata use PostgreSQL. Sources, repository
          snapshots, and generated artifacts use server storage. Cloudflare
          services provide application hosting, object storage, collaboration,
          compilation, and email delivery. Stripe processes checkout and
          payments; Texfolia stores customer and subscription identifiers and
          billing state.
        </p>
        <p>
          Operational logs and traces record requests, errors, compile activity,
          timing, and outcomes to help operate the service and diagnose
          failures. AI Gateway usage logs support billing reconciliation; the
          application disables Gateway request and response payload storage.
        </p>
        <ToBeCompleted>
          Confirm the production provider list, processing locations, applicable
          agreements, and disclosures about data sharing.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "browser-storage",
    title: "Cookies and browser storage",
    body: (
      <>
        <p>
          Session cookies support sign-in. Your browser also stores appearance
          and editor preferences, workspace layout, and a local cache of
          collaborative text for reconnecting and offline edits. Signing out
          removes your account’s cached collaborative text and workspace layouts
          from the current browser, along with legacy recovery drafts shared
          across accounts. This includes edits that have not synchronized. The
          sign-out dialog warns before discarding these edits. Save them while
          connected before signing out. Saved documents can be downloaded again
          after you sign in. Appearance and editor preferences remain in this
          browser. If cache removal fails, Texfolia shows an error so you can
          retry or clear Texfolia's site data in your browser.
        </p>
      </>
    ),
  },
  {
    id: "deletion",
    title: "Deletion and retention",
    body: (
      <>
        <p>
          Deleting a project removes access and starts cleanup of saved sources,
          collaboration state, repository data, and generated artifacts. Some
          cleanup runs in background jobs and retries failures. Deleted project
          metadata and saved chat records can remain in the database. Billing
          records have a separate lifecycle and survive account or project
          deletion.
        </p>
        <p>
          <a href={accountSettings}>Account settings</a> includes an
          email-confirmed account deletion flow. Published templates,
          independent project copies, browser caches, and files already
          downloaded or pushed to a repository host have separate lifecycles.
          Removing access does not recall those copies.
        </p>
        <ToBeCompleted>
          Specify retention periods and deletion handling for accounts, saved
          chats, deleted metadata, logs, backups, templates, and billing
          records. Do not assume immediate erasure of every copy.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "privacy-requests",
    title: "Privacy rights and requests",
    body: (
      <>
        <ToBeCompleted>
          Add applicable privacy rights, the process for access, correction, and
          deletion requests, identity verification, and the contact responsible
          for handling requests. Confirm any statements about advertising,
          selling data, or AI training.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "policy-changes",
    title: "Changes to this policy",
    body: (
      <>
        <ToBeCompleted>
          Explain how policy changes are dated and communicated, and add the
          approved disclosures for legal demands and business transfers.
        </ToBeCompleted>
      </>
    ),
  },
];

export const Route = createFileRoute("/privacy")({
  head: () =>
    pageHead({
      title: "Privacy policy template | Texfolia",
      robots: "noindex, nofollow",
    }),
  component: () => <PolicyLayout title="Privacy policy" sections={sections} />,
});
