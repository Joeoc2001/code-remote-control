import { useState, useEffect, useCallback } from "react";
import type { ConfigSummary, RepoWorkItem, Task, TaskStep } from "../types";
import { TASK_STEPS } from "../types";
import { fetchConfigs, fetchGitHubRepos, fetchGitLabRepos, fetchRepoWorkItems, createTasks } from "../api";
import RepoPicker, { type RepoEntry } from "./RepoPicker";
import { TASK_STEP_LABELS } from "./taskStepLabels";

interface NewTaskModalProps {
  onClose: () => void;
  onCreated: (tasks: Task[]) => void;
}

type WorkItemChoice = { item: RepoWorkItem; selected: boolean };

export default function NewTaskModal({ onClose, onCreated }: NewTaskModalProps) {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [gitlabConfigured, setGitlabConfigured] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<RepoEntry | null>(null);
  const [workItems, setWorkItems] = useState<WorkItemChoice[] | null>(null);
  const [customisePerStep, setCustomisePerStep] = useState(false);
  const [configByStep, setConfigByStep] = useState<Partial<Record<TaskStep, string>>>({});
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchConfigs(), fetchGitHubRepos(), fetchGitLabRepos()])
      .then(([configData, githubRepos, gitlabData]) => {
        setConfigs(configData);
        setGitlabConfigured(gitlabData.configured);
        setRepos([
          ...githubRepos.map((r) => ({ fullName: r.fullName, description: r.description, source: "github" as const })),
          ...gitlabData.repos.map((r) => ({ fullName: r.fullName, description: r.description, source: "gitlab" as const })),
        ]);
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
      if (e.key === "Escape" && !working) onClose();
    },
    [onClose, working],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    setWorkItems(null);
  }, [selectedRepo]);

  const handleLoadWorkItems = async () => {
    if (!selectedRepo) return;
    setWorking(true);
    setError(null);
    try {
      const items = await fetchRepoWorkItems(selectedRepo.fullName, selectedRepo.source);
      if (items.length === 0) {
        setError("No open issues or work items found");
        return;
      }
      setWorkItems(items.map((item) => ({ item, selected: true })));
    } catch (err) {
      setError("Failed to load work items: " + String(err));
    } finally {
      setWorking(false);
    }
  };

  const toggleWorkItem = (index: number) => {
    setWorkItems((items) =>
      items ? items.map((entry, i) => (i === index ? { ...entry, selected: !entry.selected } : entry)) : items,
    );
  };

  const setAllWorkItems = (selected: boolean) => {
    setWorkItems((items) => (items ? items.map((entry) => ({ ...entry, selected })) : items));
  };

  const selectedCount = workItems ? workItems.filter((entry) => entry.selected).length : 0;

  const handleCreate = async () => {
    if (!selectedConfig || !selectedRepo || !workItems) return;
    const workItemIds = workItems.filter((entry) => entry.selected).map((entry) => entry.item.id);
    if (workItemIds.length === 0) {
      setError("Select at least one work item");
      return;
    }

    setWorking(true);
    setError(null);
    try {
      const result = await createTasks({
        repoFullName: selectedRepo.fullName,
        repoSource: selectedRepo.source,
        workItemIds,
        configName: selectedConfig,
        configByStep: customisePerStep ? configByStep : undefined,
      });

      if (result.tasks.length > 0) {
        onCreated(result.tasks);
      }

      if (result.errors.length > 0) {
        setError(
          `Created ${result.tasks.length} tasks; ${result.errors.length} failed: ` +
            result.errors.map((e) => e.error).join("; "),
        );
        return;
      }

      onClose();
    } catch (err) {
      setError("Failed to create tasks: " + String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !working) onClose();
      }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">New Task</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Shepherds each selected work item from issue to merged PR/MR without further input.
            </p>
          </div>
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
                <button
                  type="button"
                  onClick={() => setCustomisePerStep((value) => !value)}
                  className="mt-2 text-xs text-slate-400 hover:text-slate-100"
                >
                  {customisePerStep ? "▾ Customise per step" : "▸ Customise per step"}
                </button>
                {customisePerStep && (
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 border border-slate-700 rounded-lg p-3">
                    {TASK_STEPS.map((step) => (
                      <label key={step} className="text-xs text-slate-400">
                        {TASK_STEP_LABELS[step]}
                        <select
                          value={configByStep[step] ?? selectedConfig}
                          onChange={(e) =>
                            setConfigByStep((prev) => ({ ...prev, [step]: e.target.value }))
                          }
                          className="mt-1 w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-2 py-1.5 text-sm"
                        >
                          {configs.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <RepoPicker
                repos={repos}
                gitlabConfigured={gitlabConfigured}
                selectedRepo={selectedRepo}
                onSelect={setSelectedRepo}
              />

              {workItems === null ? (
                <button
                  type="button"
                  onClick={handleLoadWorkItems}
                  disabled={!selectedConfig || !selectedRepo || working}
                  className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {working ? "Loading..." : "Load Open Work Items"}
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      {selectedCount} of {workItems.length} selected
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setAllWorkItems(true)}
                        className="text-xs text-slate-400 hover:text-slate-100"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setAllWorkItems(false)}
                        className="text-xs text-slate-400 hover:text-slate-100"
                      >
                        Deselect all
                      </button>
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto border border-slate-700 rounded-lg divide-y divide-slate-800">
                    {workItems.map((entry, index) => (
                      <label
                        key={entry.item.id}
                        className="flex items-start gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={entry.selected}
                          onChange={() => toggleWorkItem(index)}
                          className="mt-0.5 accent-indigo-500"
                        />
                        <span className="break-words">
                          {entry.item.reference} {entry.item.title}
                        </span>
                      </label>
                    ))}
                  </div>
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
            onClick={handleCreate}
            disabled={!selectedConfig || !selectedRepo || working || loading || selectedCount === 0}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {working ? "Working..." : `Create ${selectedCount} Task${selectedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
