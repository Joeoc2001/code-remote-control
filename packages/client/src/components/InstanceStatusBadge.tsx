import type { InstanceStatus } from "../types";

interface InstanceStatusBadgeProps {
  instanceStatus: InstanceStatus | null;
}

export default function InstanceStatusBadge({ instanceStatus }: InstanceStatusBadgeProps) {
  if (!instanceStatus) {
    return null;
  }

  const finished = instanceStatus.finished;
  const title = instanceStatus.updatedAt
    ? `${finished ? "Finished" : "Working"} since ${new Date(instanceStatus.updatedAt).toLocaleString()}`
    : finished
      ? "Claude has finished"
      : "Claude is working";

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        finished
          ? "border-emerald-800/80 bg-emerald-500/10 text-emerald-300"
          : "border-sky-800/80 bg-sky-500/10 text-sky-300"
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${finished ? "bg-emerald-300" : "bg-sky-300 animate-pulse"}`} />
      {finished ? "Finished" : "Working"}
    </span>
  );
}
