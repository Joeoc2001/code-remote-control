import type { TaskWorkItemBadge } from "./taskWorkItemBadge";

function WorkItemStatusIcon({ state }: { state: TaskWorkItemBadge["state"] }) {
  if (state === "closed") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-violet-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <path d="M5.2 8.2 7.2 10l3.6-3.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function WorkItemBadge({ url, label, state }: TaskWorkItemBadge) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={`${label} (${state})`}
      aria-label={`Open ${label} (${state})`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-700/80 bg-slate-800/60 px-2 py-1 text-xs text-slate-200 hover:border-slate-500 hover:text-white transition-colors"
    >
      <WorkItemStatusIcon state={state} />
      <span className="truncate">{label}</span>
    </a>
  );
}
