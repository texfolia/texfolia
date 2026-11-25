import {
  IconCode,
  IconKeyboard,
  IconPalette,
  IconTextSpellcheck,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Item, ItemContent } from "@texfolia/ui/item";

import { AppearanceSettings } from "#/components/appearance-settings";
import {
  type SettingsSection,
  useSettingsEditing,
} from "#/providers/settings-provider";

import { EditorSettings } from "./editor-settings";
import { PersonalDictionary } from "./personal-dictionary";
import { ShortcutSettings } from "./shortcut-settings";

const sections = [
  { title: "Appearance", icon: IconPalette },
  { title: "Editor", icon: IconCode },
  { title: "Spelling", icon: IconTextSpellcheck },
  { title: "Keyboard shortcuts", icon: IconKeyboard },
] satisfies { title: SettingsSection; icon: typeof IconCode }[];

export function UserSettings() {
  const { section, setSection, userReady } = useSettingsEditing();
  return (
    <div className="flex h-[min(34rem,calc(100dvh-19rem))] min-h-32 flex-col gap-5 sm:flex-row">
      <nav
        aria-label="User settings sections"
        className="flex shrink-0 flex-wrap gap-1 sm:w-44 sm:flex-col"
      >
        {sections.map(({ title, icon: Icon }) => (
          <Button
            key={title}
            variant={section === title ? "secondary" : "ghost"}
            className="justify-start"
            aria-current={section === title ? "page" : undefined}
            onClick={() => setSection(title)}
          >
            <Icon />
            {title}
          </Button>
        ))}
      </nav>
      <section
        aria-label={section}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1"
      >
        {section === "Appearance" && (
          <Item variant="outline">
            <ItemContent>
              <AppearanceSettings />
            </ItemContent>
          </Item>
        )}
        {section === "Editor" && (
          <fieldset disabled={!userReady}>
            <EditorSettings />
          </fieldset>
        )}
        {section === "Spelling" && (
          <fieldset disabled={!userReady}>
            <PersonalDictionary />
          </fieldset>
        )}
        {section === "Keyboard shortcuts" && (
          <fieldset disabled={!userReady}>
            <ShortcutSettings />
          </fieldset>
        )}
      </section>
    </div>
  );
}
