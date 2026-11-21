import { Toolbar } from "@base-ui/react/toolbar";
import { Button } from "@texfolia/ui/button";
import type { ComponentProps, ReactNode } from "react";

export function PanelHeader({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="bg-background shrink-0 border-b">
      <div className="flex h-7 items-center gap-2 px-2">
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
    <Toolbar.Root
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5"
    >
      {children}
    </Toolbar.Root>
  );
}

export function PanelAction({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Toolbar.Button>, "render"> & { label: string }) {
  return (
    <Toolbar.Button
      {...props}
      aria-label={label}
      title={label}
      render={<Button variant="ghost" size="icon-xs" />}
    >
      {children}
    </Toolbar.Button>
  );
}
