import type { EditorKeymap } from "@texfolia/editor/keymaps/keymaps";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import {
  createSequenceMatcher,
  eventChord,
  isTypingTarget,
  shortcutActions,
  startsWithModifier,
  type ShortcutAction,
  type ShortcutMap,
  yieldsToKeymap,
} from "#/lib/shortcuts";

type Registration = {
  action: ShortcutAction;
  run: () => void;
  target?: RefObject<HTMLElement | null>;
  enabled: () => boolean;
};
const ShortcutContext = createContext<Set<Registration> | null>(null);
export function ShortcutsProvider({
  map,
  editorKeymap = "default",
  children,
}: {
  map: ShortcutMap;
  // Inside the editor, Vim and Emacs keep the keys they use. See yieldsToKeymap.
  editorKeymap?: EditorKeymap;
  children: ReactNode;
}) {
  const registrations = useRef(new Set<Registration>());
  const latest = useRef(map);
  latest.current = map;
  const keymap = useRef(editorKeymap);
  keymap.current = editorKeymap;
  useEffect(() => {
    const matcher = createSequenceMatcher();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const handle = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.defaultPrevented) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="alertdialog"], [data-shortcut-recorder]')
      ) {
        matcher.reset();
        return;
      }
      const inDialog =
        event.target instanceof Element &&
        !!event.target.closest('[role="dialog"]');
      const typing = isTypingTarget(event.target);
      const inEditor =
        event.target instanceof Element &&
        !!event.target.closest(".cm-editor[data-keymap]");
      const chord = eventChord(event, mac);
      if (!chord) return;
      if (
        typing &&
        !(event.metaKey || event.ctrlKey || event.altKey) &&
        !matcher.pending(Date.now())
      ) {
        matcher.reset();
        return;
      }
      const entries = [...registrations.current].filter(
        (entry) =>
          entry.enabled() &&
          !!latest.current[entry.action] &&
          (!inDialog ||
            entry.action === "settings" ||
            entry.action === "shortcuts") &&
          (!entry.target ||
            (event.target instanceof Node &&
              entry.target.current?.contains(event.target))) &&
          (!typing ||
            (shortcutActions[entry.action].typing &&
              startsWithModifier(latest.current[entry.action]))) &&
          !(
            inEditor &&
            yieldsToKeymap(
              entry.action,
              latest.current[entry.action],
              keymap.current,
              mac,
            )
          ),
      );
      const result = matcher.match(
        chord,
        entries.map(({ action }) => ({
          id: action,
          binding: latest.current[action].replaceAll(
            mac ? "Meta" : "Ctrl",
            "Mod",
          ),
        })),
        Date.now(),
      );
      if (result.action || result.pending) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (result.action)
        entries.find((entry) => entry.action === result.action)?.run();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, []);
  return (
    <ShortcutContext value={registrations.current}>{children}</ShortcutContext>
  );
}
export function useAppShortcut(
  action: ShortcutAction,
  run: () => void,
  options: { target?: RefObject<HTMLElement | null>; enabled?: boolean } = {},
) {
  const registrations = useContext(ShortcutContext);
  const latest = useRef({ run, options });
  latest.current = { run, options };
  useEffect(() => {
    if (!registrations) return;
    const entry: Registration = {
      action,
      run: () => latest.current.run(),
      target: options.target,
      enabled: () => latest.current.options.enabled !== false,
    };
    registrations.add(entry);
    return () => {
      registrations.delete(entry);
    };
  }, [registrations, action, options.target]);
}
