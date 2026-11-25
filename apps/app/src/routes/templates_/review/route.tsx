import {
  createFileRoute,
  Link,
  useRouter,
  redirect,
  notFound,
} from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import { Textarea } from "@texfolia/ui/textarea";
import { useState } from "react";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { maxRejectionReason } from "#/lib/templates";
import {
  getTemplateReviewQueue,
  getTemplateAccount,
  reviewTemplate,
} from "#/lib/templates/template.functions";

export const Route = createFileRoute("/templates_/review")({
  beforeLoad: async () => {
    const account = await getTemplateAccount();
    if (!account.signedIn)
      throw redirect({
        to: "/login",
        search: { redirectTo: "/templates/review" },
      });
    if (!account.canReview) throw notFound();
  },
  loader: () => getTemplateReviewQueue(),
  head: () => ({
    meta: [
      { title: "Template review | Texfolia" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: TemplateReviewPage,
});

function TemplateReviewPage() {
  const { pending, reports } = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The template being rejected, by the key of the item it was chosen from.
  const [rejecting, setRejecting] = useState("");
  const [reason, setReason] = useState("");
  async function decide(data: Parameters<typeof reviewTemplate>[0]["data"]) {
    setBusy(true);
    setError("");
    try {
      await reviewTemplate({ data });
      setRejecting("");
      setReason("");
      await router.invalidate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }
  const actions = (key: string, templateId: string) =>
    rejecting === key ? (
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void decide({ templateId, decision: "rejected", reason });
        }}
      >
        <label htmlFor="rejection-reason" className="block text-sm font-medium">
          Reason shown to the publisher
        </label>
        <Textarea
          id="rejection-reason"
          required
          minLength={10}
          maxLength={maxRejectionReason}
          value={reason}
          disabled={busy}
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="flex gap-3">
          <Button
            type="submit"
            variant="destructive"
            disabled={busy || reason.trim().length < 10}
          >
            Reject / remove
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setRejecting("")}
          >
            Cancel
          </Button>
        </div>
      </form>
    ) : (
      <div className="mt-4 flex gap-3">
        <Button
          disabled={busy}
          onClick={() => void decide({ templateId, decision: "approved" })}
        >
          Approve / keep
        </Button>
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => {
            setReason("");
            setRejecting(key);
          }}
        >
          Reject / remove…
        </Button>
      </div>
    );
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main id="main-content" className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
        <h1 className="font-serif text-4xl tracking-tight sm:text-5xl">
          Template review
        </h1>
        <p className="text-muted-foreground mt-4">
          Check licensing, attribution, and content before approving a snapshot.
          You cannot review your own templates.
        </p>
        {error && (
          <p role="alert" className="text-destructive mt-6">
            {error}
          </p>
        )}
        <h2 className="mt-10 text-2xl">Pending snapshots</h2>
        {!pending.length && (
          <p className="text-muted-foreground mt-4">
            Nothing waiting for review.
          </p>
        )}
        <ul className="mt-4 divide-y">
          {pending.map((item) => (
            <li key={item.id} className="py-6">
              <Link
                to="/template/$templateId"
                params={{ templateId: item.id }}
                className="text-xl underline"
              >
                {item.title}
              </Link>
              <p className="text-muted-foreground mt-2">
                {item.publisherName} · {item.license} · {item.visibility}
              </p>
              <p className="mt-2 whitespace-pre-wrap">{item.description}</p>
              {actions(item.id, item.id)}
            </li>
          ))}
        </ul>
        <h2 className="mt-10 text-2xl">Reports</h2>
        {!reports.length && (
          <p className="text-muted-foreground mt-4">No unresolved reports.</p>
        )}
        <ul className="mt-4 divide-y">
          {reports.map((report) => (
            <li key={report.id} className="py-6">
              <Link
                to="/template/$templateId"
                params={{ templateId: report.templateId }}
                className="text-xl underline"
              >
                {report.title}
              </Link>
              <p className="mt-3 break-words whitespace-pre-wrap">
                {report.reason}
              </p>
              {actions(report.id, report.templateId)}
            </li>
          ))}
        </ul>
      </main>
      <Footer />
    </div>
  );
}
