import type { TaskPhase } from "../types";

const PHASE_STYLES: Record<TaskPhase, { label: string; className: string; dotClassName: string; pulse: boolean }> = {
  spawning: {
    label: "Spawning",
    className: "border-sky-800/80 bg-sky-500/10 text-sky-300",
    dotClassName: "bg-sky-300",
    pulse: true,
  },
  agent_running: {
    label: "Agent running",
    className: "border-sky-800/80 bg-sky-500/10 text-sky-300",
    dotClassName: "bg-sky-300",
    pulse: true,
  },
  waiting_ci: {
    label: "Waiting on CI",
    className: "border-amber-800/80 bg-amber-500/10 text-amber-300",
    dotClassName: "bg-amber-300",
    pulse: true,
  },
  waiting_approval: {
    label: "Needs approval",
    className: "border-violet-800/80 bg-violet-500/10 text-violet-300",
    dotClassName: "bg-violet-300",
    pulse: false,
  },
  merging: {
    label: "Merging",
    className: "border-emerald-800/80 bg-emerald-500/10 text-emerald-300",
    dotClassName: "bg-emerald-300",
    pulse: true,
  },
  merged: {
    label: "Merged",
    className: "border-emerald-800/80 bg-emerald-500/10 text-emerald-300",
    dotClassName: "bg-emerald-300",
    pulse: false,
  },
  failed: {
    label: "Failed",
    className: "border-rose-800/80 bg-rose-500/10 text-rose-300",
    dotClassName: "bg-rose-300",
    pulse: false,
  },
  paused: {
    label: "Paused",
    className: "border-slate-700/80 bg-slate-500/10 text-slate-300",
    dotClassName: "bg-slate-300",
    pulse: false,
  },
};

export default function TaskPhaseBadge({ phase }: { phase: TaskPhase }) {
  const style = PHASE_STYLES[phase];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style.className}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dotClassName} ${style.pulse ? "animate-pulse" : ""}`} />
      {style.label}
    </span>
  );
}
