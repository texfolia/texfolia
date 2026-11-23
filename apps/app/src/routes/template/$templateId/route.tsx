import {
  createFileRoute,
  Link,
  notFound,
  useRouter,
} from "@tanstack/react-router";
import { Button, buttonVariants } from "@texfolia/ui/button";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { Textarea } from "@texfolia/ui/textarea";
import { useState } from "react";
import { z } from "zod";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import {
  templateLicenseLabels,
  templateLicenseUrls,
} from "#/features/templates";
import { webPath } from "#/lib/origins";
import { useTemplatePreviews } from "#/lib/template-preview";
import {
  getTemplate,
  getTemplateAccount,
  openTemplate,
  refreshTemplatePreview,
  reportTemplate,
} from "#/lib/template.functions";

export const Route = createFileRoute("/template/$templateId")({
  loader: async ({ params }) => {
    if (!z.uuid().safeParse(params.templateId).success) throw notFound();
    const [template, account] = await Promise.all([
      getTemplate({ data: params }),
      getTemplateAccount(),
    ]);
    if (!template) throw notFound();
    return { template, account };
  },
  head: ({ loaderData }) => {
    const template = loaderData?.template;
    return {
      meta: template
        ? [
            { title: `${template.title} | Texfolia templates` },
            {
              name: "description",
              content: template.description.slice(0, 240),
            },
            { property: "og:title", content: template.title },
            {
              property: "og:description",
              content: template.description.slice(0, 240),
            },
            { property: "og:type", content: "article" },
            ...(template.previewUrl
              ? [{ property: "og:image", content: template.previewUrl }]
              : []),
            ...(template.visibility === "unlisted" ||
            template.status !== "approved"
              ? [{ name: "robots", content: "noindex, nofollow" }]
              : []),
          ]
        : [],
    };
  },
  notFoundComponent: () => (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main id="main-content" className="mx-auto max-w-4xl px-6 py-20">
        <h1 className="text-3xl">Template not found</h1>
        <p className="mt-4">
          This template is unavailable or still awaiting review.
        </p>
        <a href={webPath("/templates")} className="mt-6 inline-block underline">
          Browse templates
        </a>
      </main>
      <Footer />
    </div>
  ),
  component: TemplatePage,
});

function TemplatePage() {
  const { template, account } = Route.useLoaderData();
  const router = useRouter();
  useTemplatePreviews([template]);
  const navigate = Route.useNavigate();
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [reported, setReported] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Request failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main id="main-content" className="mx-auto max-w-6xl px-6 py-12 sm:py-16">
        <a
          href={webPath("/templates")}
          className="text-muted-foreground text-sm underline underline-offset-4"
        >
          All templates
        </a>
        <div className="mt-8 grid items-start gap-12 md:grid-cols-2">
          <div className="bg-muted overflow-hidden rounded-lg border">
            {template.hasPreview ? (
              <img
                src={`/api/templates/${template.id}/preview`}
                width="1200"
                height="1560"
                alt={`First page of ${template.title}`}
                className="h-auto w-full"
              />
            ) : (
              <p className="px-8 py-24 text-center">
                {template.previewStatus === "failed"
                  ? "Preview unavailable"
                  : "Generating the first-page preview…"}
              </p>
            )}
          </div>
          <section>
            <h1 className="font-serif text-4xl tracking-tight sm:text-5xl">
              {template.title}
            </h1>
            <p className="text-muted-foreground mt-3">
              By {template.publisherName} · {template.fileCount} source files
            </p>
            <p className="mt-8 leading-relaxed break-words whitespace-pre-wrap">
              {template.description}
            </p>
            <ul aria-label="Tags" className="mt-6 flex flex-wrap gap-2 text-sm">
              {template.tags.map((tag) => (
                <li key={tag} className="bg-muted rounded px-2 py-1">
                  {tag}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm">
              License:{" "}
              <a
                href={templateLicenseUrls[template.license]}
                rel="noreferrer"
                target="_blank"
                className="underline underline-offset-4"
              >
                {templateLicenseLabels[template.license]}
              </a>
            </p>
            <a
              href={`/api/templates/${template.id}/source`}
              className="mt-3 inline-block text-sm underline underline-offset-4"
            >
              Download source files (.zip)
            </a>
            {account.canReview && (
              <p className="mt-4 text-sm">
                <Link to="/templates/review" className="underline">
                  Open review queue
                </Link>
              </p>
            )}
            {template.visibility === "unlisted" && (
              <p className="text-muted-foreground mt-3 text-sm">
                Unlisted — anyone with this URL can open a copy. Not shown in
                the gallery.
              </p>
            )}
            {template.status === "approved" ? (
              <div className="mt-8 space-y-4">
                {account.signedIn ? (
                  <>
                    <label
                      htmlFor="destination"
                      className="block text-sm font-medium"
                    >
                      Create your copy in
                    </label>
                    <NativeSelect
                      id="destination"
                      value={destination}
                      onChange={(event) => setDestination(event.target.value)}
                      className="w-full"
                    >
                      <NativeSelectOption value="">
                        Personal projects
                      </NativeSelectOption>
                      {account.destinations.map((org) => (
                        <NativeSelectOption key={org.id} value={org.id}>
                          {org.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const result = await openTemplate({
                            data: {
                              templateId: template.id,
                              organizationId: destination || null,
                            },
                          });
                          await navigate({
                            to: "/project/$projectId",
                            params: { projectId: result.id },
                          });
                        })
                      }
                    >
                      {busy ? "Working…" : "Open in Texfolia"}
                    </Button>
                  </>
                ) : (
                  <Link
                    to="/login"
                    search={{ redirectTo: `/template/${template.id}` }}
                    className={buttonVariants()}
                  >
                    Sign in to open in Texfolia
                  </Link>
                )}
                <p className="text-muted-foreground text-sm">
                  Your copy is independent. Changes here or in the original
                  project won’t affect it. Follow the included license when
                  reusing or redistributing the files.
                </p>
              </div>
            ) : (
              <div
                className="mt-8 space-y-4 rounded-lg border p-5"
                role="status"
              >
                <h2 className="font-medium">
                  {
                    {
                      pending: "Waiting for review",
                      rejected: "Template not approved",
                    }[template.status]
                  }
                </h2>
                <p className="text-muted-foreground text-sm">
                  {template.error ||
                    (template.status === "pending"
                      ? "A reviewer checks each snapshot before it becomes available. Your snapshot will keep this URL."
                      : "Only you and reviewers can see this page until the template is approved.")}
                </p>
              </div>
            )}
            {template.previewStatus === "failed" && template.canManage && (
              <div className="mt-6 space-y-3" role="status">
                <p className="text-sm">
                  {template.error ||
                    "Preview unavailable. You can retry this snapshot."}
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await refreshTemplatePreview({
                        data: { templateId: template.id, retry: true },
                      });
                      await router.invalidate();
                    })
                  }
                >
                  Retry preview
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-destructive mt-4">
                {error}
              </p>
            )}
            {template.status === "approved" && (
              <details className="mt-10 border-t pt-5">
                <summary className="text-muted-foreground cursor-pointer text-sm">
                  Report this template
                </summary>
                {reported ? (
                  <p role="status" className="mt-4">
                    Report received. A reviewer will check it.
                  </p>
                ) : account.signedIn ? (
                  <form
                    className="mt-4 space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        await reportTemplate({
                          data: { templateId: template.id, reason },
                        });
                        setReported(true);
                      });
                    }}
                  >
                    <label htmlFor="report-reason" className="block text-sm">
                      Describe the licensing, safety, or content concern.
                    </label>
                    <Textarea
                      id="report-reason"
                      required
                      minLength={10}
                      maxLength={2000}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      className="min-h-32"
                    />
                    <Button variant="outline" disabled={busy}>
                      Send report
                    </Button>
                  </form>
                ) : (
                  <Link
                    to="/login"
                    search={{ redirectTo: `/template/${template.id}` }}
                    className="mt-4 inline-block underline"
                  >
                    Sign in to report
                  </Link>
                )}
              </details>
            )}
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
