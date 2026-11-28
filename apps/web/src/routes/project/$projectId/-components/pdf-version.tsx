import { Button } from "@texfolia/ui/button";
import { type ComponentProps, useMemo } from "react";
import { Document } from "react-pdf";

import { useStableCallback } from "#/hooks/use-stable-callback";
import { layoutPages } from "#/lib/pdf/layout";

import type {
  PdfVersion as Version,
  PdfVersions,
} from "../-hooks/use-pdf-versions";
import { PdfPages } from "./pdf-pages";

/** Loads and draws one version of the document. */
export function PdfVersion({
  version,
  behind,
  layout: frontLayout,
  first,
  last,
  onLoad,
  onFail,
  onPassword,
  onLink,
  onRetry,
  onEnterPassword,
  onRendered,
  onRenderFailed,
  ...pages
}: {
  version: Version;
  /** Another version still shows in front of this one. */
  behind: boolean;
  layout: ReturnType<typeof layoutPages> | undefined;
  onLoad: PdfVersions["load"];
  onFail: PdfVersions["fail"];
  onPassword: PdfVersions["askPassword"];
  onLink: NonNullable<ComponentProps<typeof Document>["onItemClick"]>;
  onRetry: () => void;
  /** Set while the document waits for a password that was not entered. */
  onEnterPassword?: () => void;
  onRendered: (id: number, page: number) => void;
  onRenderFailed: () => void;
} & Omit<
  ComponentProps<typeof PdfPages>,
  "sizes" | "layout" | "onRendered" | "onFailed"
>) {
  const { id, ready } = version;
  const { scale, rotation } = pages;
  const layout = useMemo(
    () => frontLayout ?? layoutPages(ready?.sizes ?? [], scale, rotation),
    [frontLayout, ready?.sizes, scale, rotation],
  );
  const rendered = useStableCallback((page: number) => onRendered(id, page));
  // A shorter version shows its last pages instead.
  const end = Math.max(0, (ready?.sizes.length ?? 1) - 1);
  return (
    <div
      inert={behind}
      className="[grid-area:1/1] data-behind:invisible"
      data-behind={behind ? "" : undefined}
    >
      <Document
        file={version.file}
        suspense={false}
        className="min-h-full min-w-full"
        onLoadSuccess={(pdf) => onLoad(id, pdf)}
        onLoadError={() =>
          onFail(
            id,
            "Could not load this PDF. It may be damaged or unavailable.",
          )
        }
        onSourceError={() =>
          onFail(id, "Could not read this PDF. Try another file.")
        }
        onPassword={(respond, reason) =>
          onPassword(id, respond as (password: string) => void, reason)
        }
        onItemClick={onLink}
        loading={
          onEnterPassword ? (
            <div role="alert" className="space-y-3 p-8 text-center text-sm">
              <p>A password is required to show this PDF.</p>
              <Button variant="ghost" size="sm" onClick={onEnterPassword}>
                Enter password
              </Button>
            </div>
          ) : (
            <p role="status" className="text-muted-foreground p-8 text-sm">
              Loading PDF…
            </p>
          )
        }
        error={
          <div role="alert" className="space-y-3 p-8 text-center text-sm">
            <p>{version.error ?? "Could not load PDF."}</p>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        }
      >
        {ready && (
          <PdfPages
            {...pages}
            sizes={ready.sizes}
            layout={layout}
            first={Math.min(first, end)}
            last={Math.min(last, end)}
            onRendered={rendered}
            onFailed={onRenderFailed}
          />
        )}
      </Document>
    </div>
  );
}
