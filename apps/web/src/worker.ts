import handler from "@tanstack/react-start/server-entry";

import { withSecurityHeaders } from "./lib/security-headers";

export default {
  async fetch(request: Request) {
    return withSecurityHeaders(
      await handler.fetch(request),
      import.meta.env.DEV,
    );
  },
};
