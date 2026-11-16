import {
  IconCode,
  IconKeyboard,
  IconPalette,
  IconSettings,
  IconWand,
} from "@tabler/icons-react";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { useId } from "react";

import { AppearanceSettings } from "#/components/appearance-settings";
import { LatexFormatSettingsFields } from "#/components/latex-format-settings";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Kbd } from "#/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "#/components/ui/sidebar";
import {
  type SettingsSection,
  useSettings,
} from "#/providers/settings-provider";

const sections = [
  { title: "Appearance", icon: IconPalette },
  { title: "Editor", icon: IconCode },
  { title: "Formatting", icon: IconWand },
  { title: "Keyboard shortcuts", icon: IconKeyboard },
] satisfies { title: SettingsSection; icon: typeof IconCode }[];

const shortcuts = [
  ["Save sources", "Mod + S"],
  ["Bold", "Mod + B"],
  ["Italic", "Mod + I"],
  ["Underline", "Mod + U"],
  ["Heading 1–6", "Mod + Alt + 1–6"],
  ["Normal text", "Mod + Alt + 0"],
  ["Copy / cut / paste", "Mod + C / X / V"],
  ["Open Markdown preview", "Mod + Shift + V"],
  ["Select all", "Mod + A"],
  ["Undo / redo", "Mod + Z / Mod + Shift + Z"],
  ["Find", "Mod + F"],
  ["Find next / previous", "Mod + G / Mod + Shift + G"],
  ["Find and replace", "Ctrl + H / ⌘ + Shift + H"],
  ["Indent / outdent", "Tab / Shift + Tab"],
  ["Format document", "Mod + Shift + F"],
  ["Next / previous editor tab", "Ctrl + Page Down / Page Up"],
  ["Toggle sidebar (outside editor)", "Mod + B"],
  ["Search projects", "Mod + K"],
  ["Settings", "Mod + ,"],
  ["Keyboard shortcuts", "Mod + /"],
];

export function SettingsDialog({
  iconOnly = false,
  hideTrigger = false,
}: {
  iconOnly?: boolean;
  hideTrigger?: boolean;
}) {
  const { open, setOpen } = useSettings();

  return (
    <>
      <SettingsCloseGuard />
      <Dialog open={open} onOpenChange={setOpen}>
        {!hideTrigger && (
          <DialogTrigger
            render={<SidebarMenuButton tooltip="Settings" />}
            aria-label="Settings"
          >
            <IconSettings />
            <span className={iconOnly ? "sr-only" : undefined}>Settings</span>
          </DialogTrigger>
        )}
        <DialogContent className="h-[min(640px,calc(100dvh-2rem))] overflow-hidden p-0 sm:max-w-3xl">
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Customize the app, editor, and keyboard shortcuts. Appearance is
            saved in this browser. Editor and formatting preferences sync with
            your account.
          </DialogDescription>
          <SettingsContent modal />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SettingsContent({ modal = false }: { modal?: boolean }) {
  const {
    editor,
    updateEditor,
    formatting,
    appearanceDirty,
    discard,
    apply,
    section,
    setSection,
    error,
    ready,
  } = useSettings();
  const id = useId();

  return (
    <div className="@container/settings h-full min-h-0">
      <HotkeysProvider scope={`settings-${id}`} exclusive={modal}>
        <SidebarProvider
          keyboardShortcut={false}
          className="h-full min-h-0 flex-col overflow-hidden @min-[40rem]/settings:flex-row"
        >
          <Sidebar
            collapsible="none"
            className="h-auto w-full shrink-0 border-b @min-[40rem]/settings:h-full @min-[40rem]/settings:w-48 @min-[40rem]/settings:border-r @min-[40rem]/settings:border-b-0"
          >
            <SidebarHeader className="px-4 pt-5 pb-2 font-medium">
              Settings
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <nav aria-label="Settings sections">
                  <SidebarMenu className="grid grid-cols-4 @min-[40rem]/settings:flex @min-[40rem]/settings:flex-col">
                    {sections.map(({ title, icon: Icon }) => (
                      <SidebarMenuItem key={title}>
                        <SidebarMenuButton
                          className="h-auto min-h-12 flex-col justify-center gap-1 px-1 text-xs @min-[40rem]/settings:h-8 @min-[40rem]/settings:min-h-0 @min-[40rem]/settings:flex-row @min-[40rem]/settings:justify-start @min-[40rem]/settings:gap-2 @min-[40rem]/settings:px-2 @min-[40rem]/settings:text-sm"
                          aria-label={title}
                          isActive={section === title}
                          aria-current={section === title ? "page" : undefined}
                          onClick={() => setSection(title)}
                        >
                          <Icon />
                          <span className="text-center whitespace-normal @min-[40rem]/settings:text-left">
                            {title === "Keyboard shortcuts"
                              ? "Shortcuts"
                              : title}
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </nav>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <section
            aria-label={section}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <header className="flex h-16 shrink-0 items-center gap-2 border-b px-6 pr-14">
              <span className="text-muted-foreground hidden @min-[40rem]/settings:inline">
                Settings /
              </span>
              <h2 className="font-medium">{section}</h2>
            </header>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
              <fieldset
                disabled={section !== "Appearance" && !ready}
                className="space-y-6"
              >
                {section === "Appearance" && <AppearanceSettings />}
                {section === "Editor" && (
                  <>
                    <div>
                      <h3 className="font-medium">Make room for your ideas</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Editor preferences apply to every project on your
                        account.
                      </p>
                    </div>
                    <Field>
                      <FieldLabel htmlFor={`${id}-font-size`}>
                        Font size
                      </FieldLabel>
                      <Input
                        id={`${id}-font-size`}
                        type="number"
                        min={10}
                        max={24}
                        value={editor.fontSize}
                        onChange={(event) => {
                          const fontSize = event.target.valueAsNumber;
                          if (
                            Number.isInteger(fontSize) &&
                            fontSize >= 10 &&
                            fontSize <= 24
                          )
                            updateEditor({ ...editor, fontSize });
                        }}
                      />
                    </Field>
                    <Field orientation="horizontal">
                      <Checkbox
                        id={`${id}-wrap-lines`}
                        checked={editor.wrapLines}
                        onCheckedChange={(wrapLines) =>
                          updateEditor({ ...editor, wrapLines })
                        }
                      />
                      <FieldLabel htmlFor={`${id}-wrap-lines`}>
                        Wrap lines in the editor
                      </FieldLabel>
                    </Field>
                    <p className="text-muted-foreground text-xs">
                      Save with Mod+S to sync your project sources. Use Save
                      &amp; compile to update the PDF.
                    </p>
                  </>
                )}
                {section === "Formatting" && (
                  <>
                    <div>
                      <h3 className="font-medium">LaTeX formatting</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Applied when you run Format document. Formatting does
                        not change your editor’s visual line wrapping.
                      </p>
                    </div>
                    <LatexFormatSettingsFields
                      settings={formatting.settings}
                      onChange={formatting.update}
                    />
                  </>
                )}
                {section === "Keyboard shortcuts" && (
                  <>
                    <p className="text-muted-foreground text-sm">
                      Mod means ⌘ on Mac and Ctrl on Windows or Linux. Alt means
                      Option on Mac. Formatting shortcuts apply to the focused
                      LaTeX editor. Press Escape, then Tab to move focus out of
                      the editor.
                    </p>
                    <dl className="divide-y">
                      {shortcuts.map(([label, keys]) => (
                        <div
                          key={label}
                          className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0"
                        >
                          <dt>{label}</dt>
                          <dd>
                            <Kbd className="h-auto text-right whitespace-normal">
                              {keys}
                            </Kbd>
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="text-muted-foreground text-xs">
                      Heading levels map to section, subsection, subsubsection,
                      paragraph, subparagraph, and an unnumbered subparagraph.
                    </p>
                  </>
                )}
              </fieldset>
            </div>
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t p-4">
              <span
                className="text-muted-foreground mr-auto text-xs"
                role="status"
              >
                {appearanceDirty ? "Unsaved appearance" : "Appearance saved"}
              </span>
              <Button variant="outline" onClick={discard}>
                Cancel
              </Button>
              <Button
                variant="outline"
                disabled={!appearanceDirty}
                onClick={() => apply()}
              >
                Apply
              </Button>
              <Button onClick={() => apply(true)}>Save</Button>
            </footer>
          </section>
        </SidebarProvider>
      </HotkeysProvider>
    </div>
  );
}

export function SettingsCloseGuard() {
  const { closeGuard, setCloseGuard, apply, discard } = useSettings();
  return (
    <AlertDialog open={closeGuard} onOpenChange={setCloseGuard}>
      <AlertDialogContent>
        <AlertDialogTitle>Unsaved appearance changes</AlertDialogTitle>
        <AlertDialogDescription>
          Apply your appearance changes or discard them before closing Settings.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => setCloseGuard(false)}>
            Keep editing
          </Button>
          <Button variant="outline" onClick={discard}>
            Discard
          </Button>
          <Button onClick={() => apply()}>Apply</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
