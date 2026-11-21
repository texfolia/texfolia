import { createFileRoute, Link } from "@tanstack/react-router";

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
    id: "service",
    title: "About the service",
    body: (
      <>
        <p>
          Texfolia provides an online LaTeX workspace with project storage,
          compilation, collaboration, optional Git history, reviewed templates,
          and a managed AI assistant. Available plans and features are described
          on the <Link to="/pricing">pricing page</Link>.
        </p>
        <ToBeCompleted>
          Identify the legal operator, contact details, effective date, and how
          users accept the final terms.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "accounts-and-use",
    title: "Accounts and acceptable use",
    body: (
      <>
        <ToBeCompleted>
          Define eligibility and age requirements, account responsibilities,
          prohibited uses, abuse handling, and the process for content or
          copyright complaints.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "content-and-sharing",
    title: "Your content and shared projects",
    body: (
      <>
        <p>
          Personal-project owners manage view and edit access for existing
          Texfolia accounts. Organization projects use organization membership.
          People with access can read and download project files; editors can
          change saved content. Removing access does not remove copies already
          downloaded or saved elsewhere.
        </p>
        <ToBeCompleted>
          Add content ownership wording and the permission Texfolia needs to
          store, process, compile, share, and publish content. Define
          responsibility for uploaded and shared material.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "templates",
    title: "Templates and licenses",
    body: (
      <>
        <p>
          Publishing creates a separate snapshot of saved project files.
          Submissions require confirmation of redistribution rights under the
          selected license and review before public access. Approved unlisted
          templates can be accessed by anyone with their URL. The displayed
          license applies to the source distribution. Downloads and project
          copies do not track later changes to the original project.
        </p>
        <ToBeCompleted>
          Complete the terms for publishing, moderation, license compliance, and
          removal requests.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "billing",
    title: "Subscriptions and AI billing",
    body: (
      <>
        <p>
          Stripe handles subscription checkout. Managed AI usage is billed
          separately from the plan price and compile allowances, using the model
          request cost reported by Cloudflare AI Gateway plus 20%. Failed or
          stopped assistant runs can still include billable requests, and usage
          reporting can finish after a run ends. Runs retain their original
          payer.
        </p>
        <p>
          AI spending limits apply per user and UTC calendar month. Setting the
          limit to $0 pauses new AI usage. A request can be refused before the
          displayed limit is reached when its estimated maximum cost does not
          fit the remaining budget.
        </p>
        <ToBeCompleted>
          Approve price and currency wording, renewal, cancellation, refunds,
          taxes, failed payments, plan changes, and the process for billing
          errors and disputes.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "fair-use",
    title: "Fair use",
    body: (
      <>
        <p>
          Fair use applies to compilation on all plans. Compile timeouts and
          request rate limits depend on your plan. To keep Texfolia fast and
          available for everyone, sustained heavy compilation may be temporarily
          slowed or paused. You can try again after a short wait; access
          recovers automatically as recent activity decreases.
        </p>
      </>
    ),
  },
  {
    id: "assistant",
    title: "Using the assistant",
    body: (
      <>
        <p>
          The assistant sends conversation context and project content read by
          its tools to the selected model service through Cloudflare AI Gateway.
          File edits are saved immediately and shared with collaborators. Chats
          are saved for each user and project. The{" "}
          <Link to="/privacy">privacy template</Link> describes the current data
          handling.
        </p>
        <ToBeCompleted>
          Set out responsibility for AI output, review of generated changes,
          applicable provider conditions, and any approved limitations.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "exports-and-deletion",
    title: "Exports and deletion",
    body: (
      <>
        <p>
          Project export downloads a ZIP of current saved sources, with
          generated files optional when a build exists. Optional Git commits
          keep versions; pushing keeps a copy on the connected repository host.
          Project deletion removes access and starts server cleanup, with some
          work handled by background jobs. Account deletion is available through
          an email-confirmed flow in{" "}
          <a href={accountSettings}>account settings</a>.
        </p>
        <ToBeCompleted>
          Complete retention and deletion terms, including the handling of saved
          chats, templates, independent copies, and billing records.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and termination",
    body: (
      <>
        <ToBeCompleted>
          Define when access may be suspended or terminated, how users are
          notified, and how account closure affects subscriptions and access to
          content.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "legal-terms",
    title: "Availability, liability, and disputes",
    body: (
      <>
        <ToBeCompleted>
          Add approved availability and warranty language, liability terms,
          governing law, and dispute handling. No jurisdiction or liability
          limit has been selected for this template.
        </ToBeCompleted>
      </>
    ),
  },
  {
    id: "terms-changes",
    title: "Changes and contact",
    body: (
      <>
        <ToBeCompleted>
          Explain how changes to the service and terms are communicated, and add
          a monitored support contact.
        </ToBeCompleted>
      </>
    ),
  },
];

export const Route = createFileRoute("/terms")({
  head: () =>
    pageHead({
      title: "Terms of service template | Texfolia",
      robots: "noindex, nofollow",
    }),
  component: () => (
    <PolicyLayout title="Terms of service" sections={sections} />
  ),
});
