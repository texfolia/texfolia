import {
  createFileRoute,
  Link,
  useRouter,
  redirect,
  notFound,
} from "@tanstack/react-router";
import { useState } from "react";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { Button } from "#/components/ui/button";
import {
  getTemplateReviewQueue,
  getTemplateAccount,
  reviewTemplate,
} from "#/lib/template.functions";

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
  async function decide(templateId: string, decision: "approved" | "rejected") {
    setBusy(true);
    setError("");
    try {
      await reviewTemplate({ data: { templateId, decision } });
      await router.invalidate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }
  const actions = (templateId: string) => (
    <div className="mt-4 flex gap-3">
      <Button disabled={busy} onClick={() => decide(templateId, "approved")}>
        Approve / keep
      </Button>
      <Button
        disabled={busy}
        variant="outline"
        onClick={() => decide(templateId, "rejected")}
      >
        Reject / remove
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
              {actions(item.id)}
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
              {actions(report.templateId)}
            </li>
          ))}
        </ul>
      </main>
      <Footer />
    </div>
  );
}
