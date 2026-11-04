import type { ComponentProps, ReactNode } from "react";

import { Button } from "#/components/ui/button";
import { Toolbar, ToolbarButton } from "#/components/ui/toolbar";

export function PanelHeader({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="bg-background shrink-0 border-b">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={title}
        >
          {title}
        </span>
        {children}
      </div>
    </header>
  );
}

export function PanelActions({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <Toolbar
      aria-label={label}
      className="flex-wrap rounded-none border-0 bg-transparent p-0"
    >
      {children}
    </Toolbar>
  );
}

export function PanelAction({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof ToolbarButton>, "render"> & { label: string }) {
  return (
    <ToolbarButton
      {...props}
      aria-label={label}
      title={label}
      render={<Button variant="ghost" size="icon-sm" />}
    >
      {children}
    </ToolbarButton>
  );
}
