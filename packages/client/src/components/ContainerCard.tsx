import { useState } from "react";
import { Link } from "react-router-dom";
import type { ManagedContainer } from "../types";
import { deleteContainer } from "../api";
import HealthDot from "./HealthDot";
import StatusBadge from "./StatusBadge";

interface ContainerCardProps {
  container: ManagedContainer;
  onRemoved: () => void;
}

export default function ContainerCard({
  container,
  onRemoved,
}: ContainerCardProps) {
  const [killing, setKilling] = useState(false);

  const displayName = container.name.replace(/^crc-/, "");

  const handleKill = async () => {
    if (!confirm(`Kill and remove container "${displayName}"?`)) return;
    setKilling(true);
    try {
      await deleteContainer(container.id);
      onRemoved();
    } catch (err) {
      console.error("Failed to kill container:", err);
    } finally {
      setKilling(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-white font-semibold truncate" title={container.name}>
            {displayName}
          </h3>
          <p className="text-gray-400 text-sm mt-1">{container.repoName}</p>
        </div>
        <HealthDot health={container.health} />
      </div>

      <div className="flex items-center gap-2 text-sm">
        <StatusBadge status={container.status} />
        <span className="text-gray-500">Config: {container.configName}</span>
      </div>

      <div className="mt-auto pt-3 border-t border-gray-800 flex gap-2">
        <Link
          to={`/view/${container.id}`}
          className="flex-1 px-3 py-2 text-sm font-medium text-center text-blue-400 hover:text-white hover:bg-blue-600 border border-blue-800 rounded-lg transition-colors"
        >
          View
        </Link>
        <Link
          to={`/logs/${container.id}`}
          className="flex-1 px-3 py-2 text-sm font-medium text-center text-gray-300 hover:text-white hover:bg-gray-800 border border-gray-700 rounded-lg transition-colors"
        >
          Logs
        </Link>
        <button
          onClick={handleKill}
          disabled={killing}
          className="flex-1 px-3 py-2 text-sm font-medium text-red-400 hover:text-white hover:bg-red-600 border border-red-800 rounded-lg transition-colors disabled:opacity-50"
        >
          {killing ? "Killing..." : "Kill"}
        </button>
      </div>
    </div>
  );
}
