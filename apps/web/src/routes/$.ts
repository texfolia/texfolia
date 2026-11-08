import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$")({
  server: {
    handlers: {
      GET: ({ request, context }) => context.auth.handler(request),
      POST: ({ request, context }) => context.auth.handler(request),
    },
  },
});
