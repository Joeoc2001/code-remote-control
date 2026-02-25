import type { ContainerHealth } from "../types";

interface HealthDotProps {
  health: ContainerHealth;
}

export default function HealthDot({ health }: HealthDotProps) {
  let color: string;
  let label: string;

  if (health.container === "running" && health.claudeCode === "healthy") {
    color = "bg-green-500";
    label = "Healthy";
  } else if (health.container === "running") {
    color = "bg-yellow-500";
    label = "Claude Code not detected";
  } else {
    color = "bg-red-500";
    label = "Stopped / Error";
  }

  return (
    <div className="flex items-center gap-1.5" title={label}>
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-xs text-gray-400">{label}</span>
    </div>
  );
}
