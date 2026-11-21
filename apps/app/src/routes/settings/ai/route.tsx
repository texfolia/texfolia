import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "@texfolia/ui/item";
import { useState } from "react";

import {
  getAccountAiSettings,
  saveAccountAiSettings,
} from "#/lib/account-settings.functions";
export const Route = createFileRoute("/settings/ai")({
  loader: () => getAccountAiSettings(),
  component: AiSettingsPage,
});
function AiSettingsPage() {
  const settings = Route.useLoaderData();
  const [model, setModel] = useState(settings.defaultModel ?? "");
  const [saved, setSaved] = useState(model);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">AI</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Choose the assistant’s default model for new conversations. AI
          requires Pro or Team.
        </p>
      </div>
      <Item variant="outline">
        <ItemContent className="gap-4">
          <ItemTitle>Preferred model</ItemTitle>
          <ItemDescription>
            Existing conversations keep their selected model.
          </ItemDescription>
          <label htmlFor="preferred-model" className="text-sm font-medium">
            Default AI model
          </label>
          <select
            id="preferred-model"
            className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-lg border px-3 outline-none focus-visible:ring-2"
            value={model}
            disabled={pending || !!settings.modelsError}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Use the assistant default</option>
            {settings.defaultModel &&
              !settings.models.some(
                (entry) => entry.id === settings.defaultModel,
              ) && (
                <option value={settings.defaultModel}>
                  {settings.defaultModel} (unavailable)
                </option>
              )}
            {settings.models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          {settings.modelsError && (
            <p role="alert" className="text-destructive text-sm">
              {settings.modelsError}
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <p role="status" className="text-muted-foreground text-sm">
            {message}
          </p>
          <Button
            className="w-fit"
            disabled={pending || model === saved || !!settings.modelsError}
            onClick={() => {
              setPending(true);
              setError("");
              void saveAccountAiSettings({
                data: { kind: "model", model: model || null },
              })
                .then(() => {
                  setSaved(model);
                  setMessage("Preferred model saved.");
                })
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not save model. Try again.",
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            {pending ? "Saving…" : "Save model"}
          </Button>
        </ItemContent>
      </Item>
    </div>
  );
}
