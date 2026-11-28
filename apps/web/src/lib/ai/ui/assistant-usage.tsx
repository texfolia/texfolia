import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";

import { aiConfigurationSchema, type AiConfiguration } from "../schema";
import { failureMessage, responseError } from "./assistant-client";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** What the assistant costs, and the monthly cap on it. */
export function AssistantUsage({
  endpoint,
  config,
  selected,
  onConfiguration,
}: {
  endpoint: string;
  config: AiConfiguration;
  selected: AiConfiguration["models"][number] | undefined;
  onConfiguration: (config: AiConfiguration) => void;
}) {
  const [cap, setCap] = useState(String(config.monthlyCapDollars));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: selected?.id ?? null,
          monthlyCapDollars: Number(cap),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(responseError(body, "Could not save AI settings."));
      onConfiguration(aiConfigurationSchema.parse(body));
      setSaved(true);
    } catch (failure) {
      setError(failureMessage(failure, "Could not save settings. Try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="shrink-0 border-b px-3 py-2 text-xs">
      <summary className="focus-visible:outline-ring cursor-pointer focus-visible:outline-2">
        {dollars.format(config.spentDollars)} used ·{" "}
        {dollars.format(config.monthlyCapDollars)} monthly cap
      </summary>
      <div className="space-y-3 py-3">
        <p>
          AI is billed monthly at model cost plus 20%, excluding applicable tax.
          Failed and stopped requests may still incur usage.
        </p>
        {config.reservedDollars > 0 && (
          <p role="status">
            {dollars.format(config.reservedDollars)} reserved while usage
            settles.
          </p>
        )}
        {config.needsReview && (
          <p role="status">
            Some usage needs a billing review. Its reservation stays in place
            until resolved.
          </p>
        )}
        {selected && (
          <p className="tabular-nums">
            Per million tokens:{" "}
            {dollars.format(selected.inputPrice * 1_000_000 * 1.2)} input ·{" "}
            {dollars.format(selected.outputPrice * 1_000_000 * 1.2)} output,
            including markup.
          </p>
        )}
        <label className="flex items-center justify-between gap-3">
          Monthly AI spend cap (USD)
          <Input
            className="w-24 tabular-nums md:text-xs"
            type="number"
            min="0"
            max="10000"
            step="0.01"
            value={cap}
            onChange={(event) => {
              setCap(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <p>
          Save to make the selected model your default for new chats. Caps apply
          to pre-tax usage; a $0 cap pauses AI.
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save AI preferences"}
        </Button>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">AI preferences saved.</p>}
      </div>
    </details>
  );
}
