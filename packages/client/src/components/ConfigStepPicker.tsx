import { useState } from "react";
import type { ConfigSummary, TaskStep } from "../types";
import { TASK_STEP_LABELS } from "./taskStepLabels";

interface ConfigStepPickerProps {
  configs: ConfigSummary[];
  steps: readonly TaskStep[];
  configName: string;
  onConfigNameChange: (configName: string) => void;
  configByStep: Partial<Record<TaskStep, string>>;
  onConfigByStepChange: (configByStep: Partial<Record<TaskStep, string>>) => void;
  initiallyCustomised?: boolean;
  onCustomisedChange?: (customised: boolean) => void;
  label?: string;
}

export function pickConfigOverrides(
  steps: readonly TaskStep[],
  configByStep: Partial<Record<TaskStep, string>>,
): Partial<Record<TaskStep, string>> {
  return Object.fromEntries(steps.flatMap((step) => (configByStep[step] ? [[step, configByStep[step]]] : [])));
}

export default function ConfigStepPicker({
  configs,
  steps,
  configName,
  onConfigNameChange,
  configByStep,
  onConfigByStepChange,
  initiallyCustomised = false,
  onCustomisedChange,
  label = "Configuration",
}: ConfigStepPickerProps) {
  const [customised, setCustomised] = useState(initiallyCustomised);

  return (
    <div>
      <label className="block text-sm font-medium text-slate-300 mb-1">
        {label}
        <select
          value={configName}
          onChange={(e) => onConfigNameChange(e.target.value)}
          className="mt-1 w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm font-normal"
        >
          {configs.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          setCustomised(!customised);
          onCustomisedChange?.(!customised);
        }}
        className="mt-2 text-xs text-slate-400 hover:text-slate-100"
      >
        {customised ? "▾ Customise per step" : "▸ Customise per step"}
      </button>
      {customised && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 border border-slate-700 rounded-lg p-3">
          {steps.map((step) => (
            <label key={step} className="text-xs text-slate-400">
              {TASK_STEP_LABELS[step]}
              <select
                value={configByStep[step] ?? configName}
                onChange={(e) => onConfigByStepChange({ ...configByStep, [step]: e.target.value })}
                className="mt-1 w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-2 py-1.5 text-sm"
              >
                {configs.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
