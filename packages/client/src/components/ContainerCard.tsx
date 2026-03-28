import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ManagedContainer } from "../types";
import { deleteContainer } from "../api";
import HealthDot from "./HealthDot";

interface ContainerCardProps {
  container: ManagedContainer;
  title: string;
  onRemoved: () => void;
}

export default function ContainerCard({
  container,
  title,
  onRemoved,
}: ContainerCardProps) {
  const [killing, setKilling] = useState(false);
  const navigate = useNavigate();

  const fallbackName = container.name.replace(/^crc-/, "");

  const handleKill = async () => {
    if (!confirm(`Kill and remove container "${fallbackName}"?`)) return;
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
    <article
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/view/${container.id}`)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate(`/view/${container.id}`);
        }
      }}
      className="relative cursor-pointer rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-[0_18px_45px_-28px_rgba(0,0,0,0.9)] backdrop-blur-sm flex flex-col gap-4 transition-colors hover:border-slate-600/80"
    >
      <button
        onClick={(event) => {
          event.stopPropagation();
          void handleKill();
        }}
        disabled={killing}
        className="absolute right-3 bottom-3 inline-flex h-8 w-8 items-center justify-center rounded-md border border-rose-900/80 text-rose-300 hover:text-rose-100 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
        title={killing ? "Deleting container" : "Delete container"}
        aria-label={killing ? "Deleting container" : "Delete container"}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 10v6" />
          <path d="M14 10v6" />
        </svg>
      </button>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-slate-100 font-semibold truncate" title={title}>
            {title}
          </h3>
          <p className="text-slate-400 text-sm mt-1 truncate" title={container.repoName}>
            {container.repoName}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <HealthDot health={container.health} />
          <Link
            onClick={(event) => event.stopPropagation()}
            to={`/logs/${container.id}`}
            className="text-[10px] font-medium uppercase tracking-wide text-slate-500 hover:text-slate-300 transition-colors"
          >
            Logs
          </Link>
        </div>
      </div>
    </article>
  );
}
