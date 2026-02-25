interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  let classes: string;
  switch (status) {
    case "running":
      classes = "bg-green-900 text-green-300 border-green-700";
      break;
    case "exited":
    case "stopped":
      classes = "bg-gray-800 text-gray-300 border-gray-600";
      break;
    default:
      classes = "bg-red-900 text-red-300 border-red-700";
      break;
  }

  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${classes}`}
    >
      {status}
    </span>
  );
}
