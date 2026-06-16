import { useState, useEffect, useCallback } from "react";
import type { EnvironmentConfig, ManagedContainer, RepoSource, RepoWorkItem } from "../types";
import { fetchConfigs, fetchGitHubRepos, fetchGitLabRepos, createContainer, createContainers, fetchRepoWorkItems } from "../api";

interface NewContainerModalProps {
  onClose: () => void;
  onCreated: (containers: ManagedContainer[]) => void;
}

type RepoEntry = {
  fullName: string;
  description: string | null;
  source: RepoSource;
};

const ISSUE_PROMPT_SUFFIX = "Ensure your implementation is thoroughly tested and is clearly correct from the test output. If you struggle to complete this in its entirety for any reason, including the task being too large, comment your findings and then stop.";

function buildIssuePrompt(item: RepoWorkItem): string {
  return `Address issue ${item.reference} at ${item.url}. ${ISSUE_PROMPT_SUFFIX}`;
}

export default function NewContainerModal({
  onClose,
  onCreated,
}: NewContainerModalProps) {
  const [configs, setConfigs] = useState<EnvironmentConfig[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [gitlabConfigured, setGitlabConfigured] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<RepoEntry | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | RepoSource>("all");
  const [loading, setLoading] = useState(true);
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSpawnMany, setShowSpawnMany] = useState(false);
  const [spawnManyMode, setSpawnManyMode] = useState<"issues" | "text">("issues");
  const [pastedText, setPastedText] = useState("");

  useEffect(() => {
    Promise.all([fetchConfigs(), fetchGitHubRepos(), fetchGitLabRepos()])
      .then(([configData, githubRepos, gitlabData]) => {
        setConfigs(configData);
        setGitlabConfigured(gitlabData.configured);
        const allRepos: RepoEntry[] = [
          ...githubRepos.map((r) => ({ fullName: r.fullName, description: r.description, source: "github" as const })),
          ...gitlabData.repos.map((r) => ({ fullName: r.fullName, description: r.description, source: "gitlab" as const })),
        ];
        setRepos(allRepos);
        if (configData.length > 0) setSelectedConfig(configData[0].name);
      })
      .catch((err) => {
        setError("Failed to load data: " + String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !spawning) onClose();
    },
    [onClose, spawning],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const filteredRepos = repos.filter((r) => {
    const matchesSearch = r.fullName.toLowerCase().includes(repoSearch.toLowerCase());
    const matchesSource = sourceFilter === "all" || r.source === sourceFilter;
    return matchesSearch && matchesSource;
  });

  const handleSpawn = async () => {
    if (!selectedConfig || !selectedRepo) return;
    setSpawning(true);
    setError(null);
    try {
      const container = await createContainer(selectedConfig, selectedRepo.fullName, selectedRepo.source);
      onCreated([container]);
      onClose();
    } catch (err) {
      setError("Failed to spawn container: " + String(err));
    } finally {
      setSpawning(false);
    }
  };

  const handleSpawnMany = async () => {
    if (!selectedConfig || !selectedRepo) return;
    setSpawning(true);
    setError(null);

    try {
      const prompts = spawnManyMode === "issues"
        ? (await fetchRepoWorkItems(selectedRepo.fullName, selectedRepo.source)).map(buildIssuePrompt)
        : pastedText.split("\n").map((line) => line.trim()).filter(Boolean);

      if (prompts.length === 0) {
        setError(spawnManyMode === "issues" ? "No open issues or work items found" : "Paste at least one non-empty line");
        return;
      }

      if (!window.confirm(`Spawn ${prompts.length} containers?`)) return;

      const result = await createContainers(selectedConfig, selectedRepo.fullName, selectedRepo.source, prompts);
      if (result.containers.length > 0) {
        onCreated(result.containers);
      }

      if (result.errors.length > 0) {
        setError(`Spawned ${result.containers.length} containers, ${result.errors.length} failed.`);
        return;
      }

      onClose();
    } catch (err) {
      setError("Failed to spawn containers: " + String(err));
    } finally {
      setSpawning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !spawning) onClose();
      }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-slate-100">New Container</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin h-6 w-6 border-2 border-slate-500 border-t-transparent rounded-full" />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Configuration
                </label>
                <select
                  value={selectedConfig}
                  onChange={(e) => setSelectedConfig(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm"
                >
                  {configs.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Repository
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="Search repositories..."
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    className="flex-1 bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm"
                  />
                  {gitlabConfigured && (
                    <select
                      value={sourceFilter}
                      onChange={(e) => setSourceFilter(e.target.value as "all" | RepoSource)}
                      className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="all">All</option>
                      <option value="github">GitHub</option>
                      <option value="gitlab">GitLab</option>
                    </select>
                  )}
                </div>
                <div className="max-h-48 overflow-y-auto border border-slate-700 rounded-lg">
                  {filteredRepos.length === 0 ? (
                    <div className="p-3 text-sm text-slate-500">
                      No repositories found
                    </div>
                  ) : (
                    filteredRepos.map((repo) => (
                      <button
                        key={`${repo.source}:${repo.fullName}`}
                        onClick={() => setSelectedRepo(repo)}
                        className={`w-full text-left px-3 py-2 text-sm border-b border-slate-800 last:border-0 transition-colors ${selectedRepo?.source === repo.source && selectedRepo?.fullName === repo.fullName
                          ? "bg-slate-700/40 text-slate-100"
                          : "text-slate-300 hover:bg-slate-800"
                          }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${repo.source === "gitlab"
                              ? "bg-orange-900/40 text-orange-300"
                              : "bg-slate-700 text-slate-300"
                             }`}>
                            {repo.source === "gitlab" ? "GL" : "GH"}
                          </span>
                          <span className="font-medium">{repo.fullName}</span>
                        </div>
                        {repo.description && (
                          <div className="text-xs text-slate-500 mt-0.5 truncate ml-8">
                            {repo.description}
                          </div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>

              {showSpawnMany && (
                <div className="border border-slate-700 rounded-xl bg-slate-950/40 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">Spawn Many</h3>
                      <p className="text-xs text-slate-500 mt-0.5">Creates one container per selected input using the repository above.</p>
                    </div>
                    <div className="flex rounded-lg border border-slate-700 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setSpawnManyMode("issues")}
                        className={`px-3 py-1.5 text-xs ${spawnManyMode === "issues" ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
                      >
                        Issues
                      </button>
                      <button
                        type="button"
                        onClick={() => setSpawnManyMode("text")}
                        className={`px-3 py-1.5 text-xs border-l border-slate-700 ${spawnManyMode === "text" ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
                      >
                        Pasted Text
                      </button>
                    </div>
                  </div>

                  {spawnManyMode === "issues" ? (
                    <p className="text-sm text-slate-400">
                      Spawn one container for every open {selectedRepo?.source === "gitlab" ? "issue and work item" : "issue"} on the selected repository.
                    </p>
                  ) : (
                    <textarea
                      value={pastedText}
                      onChange={(e) => setPastedText(e.target.value)}
                      placeholder="One prompt per line..."
                      rows={6}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm resize-y"
                    />
                  )}

                  <button
                    type="button"
                    onClick={handleSpawnMany}
                    disabled={!selectedConfig || !selectedRepo || spawning || loading}
                    className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {spawning ? "Spawning..." : spawnManyMode === "issues" ? "Spawn Issue Containers" : "Spawn Pasted Containers"}
                  </button>
                </div>
              )}

              {error && (
                <div className="text-rose-300 text-sm bg-rose-900/20 border border-rose-800 rounded-lg p-3">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => setShowSpawnMany((value) => !value)}
            disabled={!selectedConfig || !selectedRepo || spawning || loading}
            className="px-4 py-2 text-sm text-slate-300 hover:text-slate-100 border border-slate-700 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Spawn Many
          </button>
          <button
            onClick={handleSpawn}
            disabled={!selectedConfig || !selectedRepo || spawning || loading}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {spawning ? "Spawning..." : "Spawn"}
          </button>
        </div>
      </div>
    </div>
  );
}
