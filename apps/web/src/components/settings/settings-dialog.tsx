import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@texfolia/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@texfolia/ui/tabs";

import { useSettingsEditing } from "#/providers/settings-provider";

import { ProjectSettings } from "./project-settings";
import { SettingsCloseGuard, SettingsFooter } from "./settings-footer";
import { UserSettings } from "./user-settings";

export function SettingsDialog() {
  const settings = useSettingsEditing();
  return (
    <>
      <Dialog open={settings.open} onOpenChange={settings.setOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              User preferences apply in this browser. Project settings are
              shared with collaborators.
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={!settings.ready || settings.saving}
            // A fieldset does not shrink its contents, so it takes no part in
            // the layout.
            className="contents"
          >
            <Tabs defaultValue="user" className="min-h-0 flex-1 gap-4">
              <TabsList aria-label="Settings scope" className="shrink-0">
                <TabsTrigger value="user" className="px-5">
                  User
                </TabsTrigger>
                <TabsTrigger value="project" className="px-5">
                  Project
                </TabsTrigger>
              </TabsList>
              <TabsContent value="user" className="min-h-0">
                <UserSettings />
              </TabsContent>
              <TabsContent value="project" className="min-h-0 overflow-y-auto">
                <ProjectSettings />
              </TabsContent>
            </Tabs>
          </fieldset>
          <SettingsFooter />
        </DialogContent>
      </Dialog>
      <SettingsCloseGuard />
    </>
  );
}
