import type { InstanceState, InstanceStatus } from "../types";

interface InstanceStatusBadgeProps {
  instanceStatus: InstanceStatus | null;
}

const VARIANTS: Record<InstanceState, { label: string; idle: string; pill: string; dot: string }> = {
  working: {
    label: "Working",
    idle: "Claude is working",
    pill: "border-sky-800/80 bg-sky-500/10 text-sky-300",
    dot: "bg-sky-300 animate-pulse",
  },
  waiting: {
    label: "Waiting",
    idle: "Claude is waiting for your input",
    pill: "border-amber-800/80 bg-amber-500/10 text-amber-300",
    dot: "bg-amber-300 animate-pulse",
  },
  "awaiting-background": {
    label: "Waiting on agents",
    idle: "Claude is waiting on background agents",
    pill: "border-violet-800/80 bg-violet-500/10 text-violet-300",
    dot: "bg-violet-300 animate-pulse",
  },
  finished: {
    label: "Finished",
    idle: "Claude has finished",
    pill: "border-emerald-800/80 bg-emerald-500/10 text-emerald-300",
    dot: "bg-emerald-300",
  },
};

export default function InstanceStatusBadge({ instanceStatus }: InstanceStatusBadgeProps) {
  if (!instanceStatus) {
    return null;
  }

  const variant = VARIANTS[instanceStatus.state];
  const since = instanceStatus.state === "waiting" ? "Waiting for your input since" : `${variant.label} since`;
  const title = instanceStatus.updatedAt
    ? `${since} ${new Date(instanceStatus.updatedAt).toLocaleString()}`
    : variant.idle;

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${variant.pill}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${variant.dot}`} />
      {variant.label}
    </span>
  );
}
