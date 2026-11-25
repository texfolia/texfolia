import { MenubarItem, MenubarShortcut } from "@texfolia/ui/menubar";
import { type ComponentProps, useState } from "react";

import {
  bindingKeyShortcuts,
  bindingLabel,
  isMac,
  type ShortcutAction,
} from "#/lib/shortcuts/shortcuts";
import { useSettings } from "#/providers/settings-provider";

/**
 * The keys of a menu item: those now set for an action, or a fixed binding of
 * the editor. The hint is hidden from the item's name, which gets the keys
 * through `aria-keyshortcuts`.
 */
export function useMenuShortcut({
  action,
  binding: fixed,
}: {
  action?: ShortcutAction;
  binding?: string;
}) {
  const { shortcuts } = useSettings();
  const [mac] = useState(isMac);
  const binding = action ? shortcuts[action] : fixed;
  if (!binding) return { hint: null, keys: undefined };
  return {
    hint: (
      <MenubarShortcut aria-hidden="true" className="pl-4">
        {bindingLabel(binding, mac)}
      </MenubarShortcut>
    ),
    keys: bindingKeyShortcuts(binding, mac),
  };
}

export function ShortcutMenuItem({
  action,
  binding,
  children,
  ...props
}: ComponentProps<typeof MenubarItem> & {
  action?: ShortcutAction;
  binding?: string;
}) {
  const { hint, keys } = useMenuShortcut({ action, binding });
  return (
    <MenubarItem {...props} aria-keyshortcuts={keys}>
      {children}
      {hint}
    </MenubarItem>
  );
}
