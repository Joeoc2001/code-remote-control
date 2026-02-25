import { useState } from "react";
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
  const [copied, setCopied] = useState(false);

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

  const handleCopyUrl = async () => {
    if (!container.remoteUrl) return;
    await navigator.clipboard.writeText(container.remoteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

      <div className="mt-1">
        {container.remoteUrl ? (
          <div className="flex items-center gap-2">
            <a
              href={container.remoteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 text-sm truncate"
            >
              {container.remoteUrl}
            </a>
            <button
              onClick={handleCopyUrl}
              className="shrink-0 text-gray-400 hover:text-white text-xs px-2 py-1 border border-gray-700 rounded transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="animate-spin h-4 w-4 border-2 border-gray-500 border-t-transparent rounded-full" />
            Waiting for Remote URL...
          </div>
        )}
      </div>

      <div className="mt-auto pt-3 border-t border-gray-800">
        <button
          onClick={handleKill}
          disabled={killing}
          className="w-full px-3 py-2 text-sm font-medium text-red-400 hover:text-white hover:bg-red-600 border border-red-800 rounded-lg transition-colors disabled:opacity-50"
        >
          {killing ? "Killing..." : "Kill"}
        </button>
      </div>
    </div>
  );
}
