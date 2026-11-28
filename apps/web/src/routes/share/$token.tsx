import { createFileRoute } from "@tanstack/react-router";

import { LinkNoLongerWorks } from "#/components/link-no-longer-works";
import { shareTokenPattern } from "#/lib/sharing/share-token";

// The link people receive. It only redeems the token and redirects to the
// project's one URL, `/project/$projectId`, so the token leaves the address bar
// and is never sent as a Referer. Links that no longer work fall through to the
// page below.
export const Route = createFileRoute("/share/$token")({
  ssr: false,
  server: {
    handlers: {
      GET: async ({ request, params, context, next }) => {
        if (!shareTokenPattern.test(params.token)) return next();
        const [
          { env },
          { redeemShareLink },
          { shareCookie, clearShareCookie },
        ] = await Promise.all([
          import("cloudflare:workers"),
          import("#/lib/sharing/project-share-links.server"),
          import("#/lib/sharing/share-cookie.server"),
        ]);
        const session = await context.auth.api.getSession({
          headers: request.headers,
          query: { disableRefresh: true },
        });
        const redeemed = await redeemShareLink({
          db: context.db,
          token: params.token,
          userId: session?.user.id ?? null,
          live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
        });
        if (!redeemed) return next();
        const { projectId, signIn } = redeemed;
        const secure = new URL(request.url).protocol === "https:";
        const project = `/project/${encodeURIComponent(projectId)}`;
        const headers = new Headers({
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          Location: signIn
            ? `/login?${new URLSearchParams({ redirectTo: project })}`
            : project,
        });
        headers.append(
          "Set-Cookie",
          session
            ? clearShareCookie(projectId, secure)
            : shareCookie(projectId, params.token, { pending: signIn, secure }),
        );
        return new Response(null, { status: 303, headers });
      },
    },
  },
  head: () => ({
    meta: [
      { title: "Shared project | Texfolia" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: LinkNoLongerWorks,
});
