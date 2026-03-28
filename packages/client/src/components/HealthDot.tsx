import type { ContainerHealth } from "../types";

interface HealthDotProps {
  health: ContainerHealth;
}

export default function HealthDot({ health }: HealthDotProps) {
  let color: string;
  let label: string | null;

  if (health.container === "running" && health.openCode === "healthy") {
    color = "bg-slate-300";
    label = null;
  } else if (health.container === "running" && health.openCode === "unhealthy") {
    color = "bg-amber-400";
    label = "Running · opencode unhealthy";
  } else if (health.container === "running") {
    color = "bg-amber-400";
    label = "Running · waiting for opencode";
  } else {
    color = "bg-rose-400";
    label = "Container offline";
  }

  return (
    <div className="flex items-center gap-1.5" title={label ?? "Running · opencode ready"}>
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />
      {label && <span className="text-xs text-slate-300">{label}</span>}
    </div>
  );
}
