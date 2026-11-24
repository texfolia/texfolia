import { IconChevronsUp, IconLogout } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@texfolia/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@texfolia/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@texfolia/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@texfolia/ui/sidebar";
import { useState } from "react";

import { signOut } from "#/lib/auth/sign-out";
import { settingsLinks } from "#/lib/settings/settings-navigation";

import { initials } from "./project-columns";

export function ProjectAccountMenu({
  user,
}: {
  user: { id: string; name: string; email: string; image?: string | null };
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<SidebarMenuButton size="lg" />}
              aria-label="Account menu"
            >
              <Avatar>
                <AvatarImage src={user.image ?? undefined} alt="" />
                <AvatarFallback>{initials(user.name)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium">{user.name}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {user.email}
                </span>
              </span>
              <IconChevronsUp />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>My account</DropdownMenuLabel>
                {settingsLinks.map(({ to, label, icon: Icon }) => (
                  <DropdownMenuItem key={to} render={<Link to={to} />}>
                    <Icon />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setError("");
                  setConfirming(true);
                }}
              >
                <IconLogout />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!pending) setConfirming(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of Texfolia?</AlertDialogTitle>
            <AlertDialogDescription>
              Signing out removes local document copies and resets your
              workspace layouts in this browser, including any edits that have
              not synced. Cancel and reconnect to save those edits first. Saved
              projects will be available when you sign back in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={async () => {
                if (pending) return;
                setPending(true);
                setError("");
                try {
                  await signOut(user.id);
                  window.location.assign("/");
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not sign out. Try again.",
                  );
                  setPending(false);
                }
              }}
            >
              {pending ? "Signing out…" : "Sign out"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
