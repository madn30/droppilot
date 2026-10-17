"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveSettingsAction } from "./actions";
import { SETTINGS_SECTIONS, type SettingsField, type SettingsFormState } from "./form";

const INITIAL_STATE: SettingsFormState = { saved: false, errors: {} };

const UNIT: Partial<Record<SettingsField["kind"], string>> = { percent: "%", money: "$" };

function label(option: string): string {
  return option.toLowerCase().replaceAll("_", " ");
}

function FieldControl({ field, value, invalid }: { field: SettingsField; value: string; invalid: boolean }) {
  if (field.kind === "boolean") {
    return (
      <input
        id={field.path}
        name={field.path}
        type="checkbox"
        defaultChecked={value === "on"}
        className="size-4 accent-primary"
      />
    );
  }
  if (field.kind === "select") {
    return (
      <select
        id={field.path}
        name={field.path}
        defaultValue={value}
        aria-invalid={invalid}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm capitalize outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {field.options.map((option) => (
          <option key={option} value={option}>
            {label(option)}
          </option>
        ))}
      </select>
    );
  }
  const unit = UNIT[field.kind];
  return (
    <div className="flex items-center gap-2">
      <Input
        id={field.path}
        name={field.path}
        type="number"
        inputMode="decimal"
        step={field.kind === "integer" ? 1 : "any"}
        min={0}
        defaultValue={value}
        aria-invalid={invalid}
      />
      {unit && <span className="w-4 text-sm text-muted-foreground">{unit}</span>}
    </div>
  );
}

export function SettingsForm({ values }: { values: Record<string, string> }) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, INITIAL_STATE);
  const errorCount = Object.keys(state.errors).length;
  const shown = state.submitted ?? values;

  return (
    <form action={formAction} className="space-y-6">
      {/* Inputs are uncontrolled: remount them whenever the values they start from change. */}
      <div key={JSON.stringify(shown)} className="space-y-6">
        {SETTINGS_SECTIONS.map((section) => (
          <Card key={section.title}>
            <CardHeader>
              <CardTitle>{section.title}</CardTitle>
              <CardDescription>{section.description}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.fields.map((field) => {
                const error = state.errors[field.path];
                return (
                  <div key={field.path} className="space-y-1.5">
                    <Label htmlFor={field.path}>{field.label}</Label>
                    <FieldControl field={field} value={shown[field.path] ?? ""} invalid={Boolean(error)} />
                    {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                    {error && <p className="text-xs text-destructive">{error}</p>}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        <p role="status" className="text-sm">
          {state.saved && <span className="text-muted-foreground">Settings saved.</span>}
          {errorCount > 0 && (
            <span className="text-destructive">
              Not saved — fix {errorCount} highlighted {errorCount === 1 ? "field" : "fields"}.
            </span>
          )}
        </p>
      </div>
    </form>
  );
}
