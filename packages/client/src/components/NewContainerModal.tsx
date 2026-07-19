import { useState, useEffect, useCallback } from "react";
import type { ConfigSummary, ManagedContainer, RepoReviewRequest, RepoSource, RepoWorkItem } from "../types";
import { fetchConfigs, fetchGitHubRepos, fetchGitLabRepos, createContainer, createContainers, fetchRepoReviewRequests, fetchRepoWorkItems } from "../api";

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

type SpawnManyMode = "issues" | "reviewRequests" | "reviewComments" | "rebase" | "fixCi" | "text";

type SpawnItem = { label: string; prompt: string; selected: boolean };

const SPAWN_MANY_MODES: Array<{ mode: SpawnManyMode; label: string }> = [
  { mode: "issues", label: "Issues" },
  { mode: "reviewRequests", label: "Review PR/MRs" },
  { mode: "reviewComments", label: "Fix Comments" },
  { mode: "rebase", label: "Rebase on Main" },
  { mode: "fixCi", label: "Fix Failing CI" },
  { mode: "text", label: "Pasted Text" },
];

function reviewRequestNoun(item: RepoReviewRequest): string {
  return item.kind === "merge_request" ? "merge request" : "pull request";
}

function buildIssuePrompt(item: RepoWorkItem): string {
  return `Address issue ${item.reference} at ${item.url}. ${ISSUE_PROMPT_SUFFIX}`;
}

function buildReviewRequestPrompt(item: RepoReviewRequest): string {
  return `Review ${reviewRequestNoun(item)} ${item.reference} at ${item.url}, leaving comments with suggestions and recommendations.`;
}

function buildReviewCommentsPrompt(item: RepoReviewRequest): string {
  return `Address all open comments on ${reviewRequestNoun(item)} ${item.reference} at ${item.url}, closing comments as they are resolved.`;
}

function buildRebasePrompt(item: RepoReviewRequest): string {
  return `Rebase ${reviewRequestNoun(item)} ${item.reference} at ${item.url} onto the main branch, resolving any merge conflicts, and force-push the rebased branch.`;
}

function buildFixCiPrompt(item: RepoReviewRequest): string {
  return `Investigate the failing CI on ${reviewRequestNoun(item)} ${item.reference} at ${item.url} and push fixes to its branch until CI passes.`;
}

function referenceLabel(item: { reference: string; title: string }): string {
  return `${item.reference} ${item.title}`;
}

export default function NewContainerModal({
  onClose,
  onCreated,
}: NewContainerModalProps) {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
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
  const [spawnManyMode, setSpawnManyMode] = useState<SpawnManyMode>("issues");
  const [pastedText, setPastedText] = useState("");
  const [spawnItems, setSpawnItems] = useState<SpawnItem[] | null>(null);

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

  useEffect(() => {
    setSpawnItems(null);
  }, [spawnManyMode, selectedRepo, pastedText, showSpawnMany]);

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

  const handlePrepareSpawnMany = async () => {
    if (!selectedConfig || !selectedRepo) return;
    setSpawning(true);
    setError(null);

    try {
      const items = await buildSpawnManyItems(selectedRepo);

      if (items.length === 0) {
        setError(getEmptySpawnManyError(selectedRepo));
        return;
      }

      setSpawnItems(items.map((item) => ({ ...item, selected: true })));
    } catch (err) {
      setError("Failed to load items: " + String(err));
    } finally {
      setSpawning(false);
    }
  };

  const handleSpawnMany = async () => {
    if (!selectedConfig || !selectedRepo || !spawnItems) return;
    const prompts = spawnItems.filter((item) => item.selected).map((item) => item.prompt);

    if (prompts.length === 0) {
      setError("Select at least one item to spawn");
      return;
    }

    setSpawning(true);
    setError(null);

    try {
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

  const toggleSpawnItem = (index: number) => {
    setSpawnItems((items) =>
      items ? items.map((item, i) => (i === index ? { ...item, selected: !item.selected } : item)) : items,
    );
  };

  const setAllSpawnItems = (selected: boolean) => {
    setSpawnItems((items) => (items ? items.map((item) => ({ ...item, selected })) : items));
  };

  const buildSpawnManyItems = async (repo: RepoEntry): Promise<Omit<SpawnItem, "selected">[]> => {
    if (spawnManyMode === "issues") {
      return (await fetchRepoWorkItems(repo.fullName, repo.source)).map((item) => ({
        label: referenceLabel(item),
        prompt: buildIssuePrompt(item),
      }));
    }

    if (spawnManyMode === "text") {
      return pastedText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((prompt) => ({ label: prompt, prompt }));
    }

    const reviewRequests = await fetchRepoReviewRequests(repo.fullName, repo.source);

    if (spawnManyMode === "rebase") {
      return reviewRequests
        .filter((item) => item.hasConflicts)
        .map((item) => ({ label: referenceLabel(item), prompt: buildRebasePrompt(item) }));
    }

    if (spawnManyMode === "fixCi") {
      return reviewRequests
        .filter((item) => item.ciFailing)
        .map((item) => ({ label: referenceLabel(item), prompt: buildFixCiPrompt(item) }));
    }

    if (spawnManyMode === "reviewComments") {
      return reviewRequests
        .filter((item) => item.hasUnresolvedComments)
        .map((item) => ({ label: referenceLabel(item), prompt: buildReviewCommentsPrompt(item) }));
    }

    return reviewRequests
      .filter((item) => item.hasConflicts || item.ciFailing)
      .map((item) => ({ label: referenceLabel(item), prompt: buildReviewRequestPrompt(item) }));
  };

  const getEmptySpawnManyError = (repo: RepoEntry): string => {
    const noun = repo.source === "gitlab" ? "merge requests" : "pull requests";

    if (spawnManyMode === "issues") {
      return "No open issues or work items found";
    }

    if (spawnManyMode === "reviewRequests") {
      return `No open ${noun} with merge conflicts or failing CI found`;
    }

    if (spawnManyMode === "reviewComments") {
      return `No open ${noun} with unresolved comments found`;
    }

    if (spawnManyMode === "rebase") {
      return `No open ${noun} with merge conflicts found`;
    }

    if (spawnManyMode === "fixCi") {
      return `No open ${noun} with failing CI found`;
    }

    return "Paste at least one non-empty line";
  };

  const getPrepareButtonLabel = (): string => {
    if (spawning) return "Loading...";
    if (spawnManyMode === "issues") return "Preview Issue Containers";
    if (spawnManyMode === "reviewRequests") return "Preview Review Containers";
    if (spawnManyMode === "reviewComments") return "Preview Comment Fix Containers";
    if (spawnManyMode === "rebase") return "Preview Rebase Containers";
    if (spawnManyMode === "fixCi") return "Preview CI Fix Containers";
    return "Preview Pasted Containers";
  };

  const selectedSpawnCount = spawnItems ? spawnItems.filter((item) => item.selected).length : 0;

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
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">Spawn Many</h3>
                    <p className="text-xs text-slate-500 mt-0.5">Creates one container per selected input using the repository above.</p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-slate-700 border border-slate-700 rounded-lg overflow-hidden">
                    {SPAWN_MANY_MODES.map(({ mode, label }) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setSpawnManyMode(mode)}
                        className={`px-3 py-1.5 text-xs ${spawnManyMode === mode ? "bg-slate-700 text-slate-100" : "bg-slate-900 text-slate-400 hover:bg-slate-800"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {spawnManyMode === "issues" ? (
                    <p className="text-sm text-slate-400">
                      Spawn one container for every open {selectedRepo?.source === "gitlab" ? "issue and work item" : "issue"} on the selected repository.
                    </p>
                  ) : spawnManyMode === "reviewRequests" ? (
                    <p className="text-sm text-slate-400">
                      Spawn one container for every open {selectedRepo?.source === "gitlab" ? "merge request" : "pull request"} with merge conflicts or failing CI to review it and leave comments with suggestions and recommendations.
                    </p>
                  ) : spawnManyMode === "reviewComments" ? (
                    <p className="text-sm text-slate-400">
                      Spawn one container for every open {selectedRepo?.source === "gitlab" ? "merge request" : "pull request"} with unresolved comments to address all open comments and close them as they are resolved.
                    </p>
                  ) : spawnManyMode === "rebase" ? (
                    <p className="text-sm text-slate-400">
                      Spawn one container for every open {selectedRepo?.source === "gitlab" ? "merge request" : "pull request"} with merge conflicts to rebase it onto the main branch and resolve the conflicts.
                    </p>
                  ) : spawnManyMode === "fixCi" ? (
                    <p className="text-sm text-slate-400">
                      Spawn one container for every open {selectedRepo?.source === "gitlab" ? "merge request" : "pull request"} with failing CI to investigate and fix the failures.
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

                  {spawnItems === null ? (
                    <button
                      type="button"
                      onClick={handlePrepareSpawnMany}
                      disabled={!selectedConfig || !selectedRepo || spawning || loading}
                      className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {getPrepareButtonLabel()}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-400">
                          {selectedSpawnCount} of {spawnItems.length} selected
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setAllSpawnItems(true)}
                            className="text-xs text-slate-400 hover:text-slate-100"
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            onClick={() => setAllSpawnItems(false)}
                            className="text-xs text-slate-400 hover:text-slate-100"
                          >
                            Deselect all
                          </button>
                        </div>
                      </div>
                      <div className="max-h-48 overflow-y-auto border border-slate-700 rounded-lg divide-y divide-slate-800">
                        {spawnItems.map((item, index) => (
                          <label
                            key={index}
                            className="flex items-start gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={item.selected}
                              onChange={() => toggleSpawnItem(index)}
                              className="mt-0.5 accent-indigo-500"
                            />
                            <span className="break-words">{item.label}</span>
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={handleSpawnMany}
                        disabled={!selectedConfig || !selectedRepo || spawning || loading || selectedSpawnCount === 0}
                        className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {spawning ? "Spawning..." : `Spawn ${selectedSpawnCount} Container${selectedSpawnCount === 1 ? "" : "s"}`}
                      </button>
                    </div>
                  )}
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
