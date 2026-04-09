import { useParams, Link, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import type { ManagedContainer, ContainerCodeStatus } from "../types";
import { fetchIframeDomain, fetchContainerCodeStatus, deleteContainer } from "../api";

const BASE = "/api";

export default function ContainerView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [container, setContainer] = useState<ManagedContainer | null>(null);
  const [rootDomain, setRootDomain] = useState<string | undefined>(undefined);
  const [codeStatus, setCodeStatus] = useState<ContainerCodeStatus | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);
  const currentTaskTitle = codeStatus?.currentTaskDescription?.trim() || "No current task";
  const activeReviewRequest = codeStatus?.reviewRequest?.url ? codeStatus.reviewRequest : null;

  const handleDelete = async () => {
    if (!container) return;
    const fallbackName = container.name.replace(/^crc-/, "");
    if (!confirm(`Kill and remove container "${fallbackName}"?`)) return;

    setKilling(true);
    navigate("/", { replace: true });
    void deleteContainer(container.id).catch((err) => {
      console.error("Failed to kill container:", err);
    });
  };

  useEffect(() => {
    let cancelled = false;

    async function refreshCodeStatus(containerId: string) {
      try {
        const status = await fetchContainerCodeStatus(containerId);
        if (!cancelled) {
          setCodeStatus(status);
          setMetadataError(null);
        }
      } catch (err) {
        console.error("Failed to load container code status:", err);
        if (!cancelled) {
          setMetadataError("Code status unavailable");
        }
      }
    }

    async function fetchData() {
      try {
        const [res, domain] = await Promise.all([
          fetch(`${BASE}/containers/${id}`),
          fetchIframeDomain(),
        ]);
        if (!res.ok) throw new Error("Failed to fetch container");
        const data = await res.json();
        setContainer(data);
        setRootDomain(domain);
        setError(null);
        if (id) {
          await refreshCodeStatus(id);
        }
      } catch (err) {
        console.error("Failed to load container:", err);
        setError("Failed to load container");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchData();

    if (id) {
      const interval = setInterval(() => {
        refreshCodeStatus(id).catch((err) => {
          console.error("Failed to refresh code status:", err);
        });
      }, 30000);

      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100">
      <header className="shrink-0 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          <Link
            to="/"
            className="text-slate-400 hover:text-slate-100 transition-colors"
          >
            ← Back
          </Link>
          <h1 className="flex-1 truncate text-xl font-semibold">{currentTaskTitle}</h1>
          {!loading && !error && container && (
            <div className="ml-auto flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void handleDelete();
                  }}
                  disabled={killing}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rose-900/80 text-rose-300 hover:text-rose-100 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
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
                <button
                  type="button"
                  onClick={() => setMetadataOpen((prev) => !prev)}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-slate-300 hover:border-slate-500 hover:text-slate-100 transition-colors"
                >
                  {metadataOpen ? "Hide metadata" : "Show metadata"}
                  <span>{metadataOpen ? "v" : ">"}</span>
                </button>
              </div>
              {activeReviewRequest && (
                <a
                  className="text-xs text-sky-300 hover:text-sky-200"
                  href={activeReviewRequest.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  PR/MR #{activeReviewRequest.id}
                </a>
              )}
            </div>
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin h-8 w-8 border-2 border-slate-500 border-t-transparent rounded-full" />
        </div>
      ) : error || !container ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-rose-300 text-lg">{error || "Container not found"}</p>
        </div>
      ) : (
        <>
          <section className="shrink-0 border-b border-slate-800 bg-slate-950/70">
            {metadataOpen && (
              <>
                <div className="max-w-7xl mx-auto px-4 pb-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
                  <span><span className="text-slate-400">Config:</span> {container.configName || "-"}</span>
                  <span><span className="text-slate-400">Repo:</span> {codeStatus ? (codeStatus.orgName && codeStatus.repoName ? `${codeStatus.orgName}/${codeStatus.repoName}` : codeStatus.repoName || "-") : "-"}</span>
                  <span><span className="text-slate-400">Branch:</span> {codeStatus?.branch || "-"}</span>
                  <span><span className="text-slate-400">Commit:</span> <span className="font-mono text-xs">{codeStatus?.commitSha || "-"}</span></span>
                  <span><span className="text-slate-400">PR / MR:</span> {codeStatus?.reviewRequest ? `#${codeStatus.reviewRequest.id} ${codeStatus.reviewRequest.state}` : "No active PR/MR"}</span>
                  <span><span className="text-slate-400">Pipeline:</span> {codeStatus?.pipeline?.status || "No pipeline data"}</span>
                </div>
                <div className="max-w-7xl mx-auto px-4 pb-3 text-xs text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
                  <span>Provider: {codeStatus?.provider || "-"}</span>
                  {codeStatus?.reviewRequest?.url && (
                    <a
                      className="text-slate-300 hover:text-slate-100"
                      href={codeStatus.reviewRequest.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open PR/MR
                    </a>
                  )}
                  {codeStatus?.pipeline?.url && (
                    <a
                      className="text-slate-300 hover:text-slate-100"
                      href={codeStatus.pipeline.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Pipeline
                    </a>
                  )}
                  {metadataError && <span className="text-amber-300">{metadataError}</span>}
                  {codeStatus?.warnings[0] && <span className="text-amber-300 truncate">{codeStatus.warnings[0]}</span>}
                </div>
              </>
            )}
          </section>
          <iframe
            src={`https://${container.subdomain}.${rootDomain}/`}
            className="flex-1 w-full border-none"
            title="Container Web View"
          />
        </>
      )}
    </div>
  );
}
