import type { ReactNode } from "react";

import { Footer } from "./footer";
import { Header } from "./header";

/** Header, page content, and footer for a marketing page. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      {children}
      <Footer />
    </div>
  );
}
