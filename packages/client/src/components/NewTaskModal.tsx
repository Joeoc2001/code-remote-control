import { memo, useState, useEffect, useCallback } from "react";
import type { AttachableReviewRequest, ConfigSummary, QuickPrompt, RepoWorkItem, Task, TaskStep } from "../types";
import { TASK_STEPS } from "../types";
import {
  fetchConfigs,
  fetchGitHubRepos,
  fetchGitLabRepos,
  fetchRepoWorkItems,
  createTasks,
  createTaskFromText,
  fetchQuickPrompts,
  createQuickPrompt,
  deleteQuickPrompt,
  launchQuickPrompt,
  fetchAttachableReviewRequests,
  createTaskFromReviewRequest,
} from "../api";
import RepoPicker, { type RepoEntry } from "./RepoPicker";
import ProseTextArea from "./ProseTextArea";
import ConfigStepPicker, { pickConfigOverrides } from "./ConfigStepPicker";

interface NewTaskModalProps {
  onClose: () => void;
  onCreated: (tasks: Task[]) => void;
}

type WorkItemChoice = { item: RepoWorkItem; selected: boolean };

type TaskMode = "work_items" | "text" | "quick_prompt" | "review_request";

const TASK_MODES: Array<{ mode: TaskMode; label: string }> = [
  { mode: "work_items", label: "From work items" },
  { mode: "text", label: "From pasted text" },
  { mode: "quick_prompt", label: "From quick-prompt" },
  { mode: "review_request", label: "From open PR/MR" },
];

function NewTaskModal({ onClose, onCreated }: NewTaskModalProps) {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [gitlabConfigured, setGitlabConfigured] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<RepoEntry | null>(null);
  const [workItems, setWorkItems] = useState<WorkItemChoice[] | null>(null);
  const [mode, setMode] = useState<TaskMode>("work_items");
  const [pastedText, setPastedText] = useState("");
  const [savedPastedText, setSavedPastedText] = useState<string | null>(null);
  const [quickPrompts, setQuickPrompts] = useState<QuickPrompt[] | null>(null);
  const [selectedQuickPromptId, setSelectedQuickPromptId] = useState<string | null>(null);
  const [newQuickPromptText, setNewQuickPromptText] = useState("");
  const [customisePerStep, setCustomisePerStep] = useState(false);
  const [configByStep, setConfigByStep] = useState<Partial<Record<TaskStep, string>>>({});
  const [attachable, setAttachable] = useState<AttachableReviewRequest[] | null>(null);
  const [selectedReviewRequestId, setSelectedReviewRequestId] = useState<string | null>(null);
  const [selectedAttachWorkItemId, setSelectedAttachWorkItemId] = useState<string | null>(null);
  const usesTextPipeline = mode === "text" || mode === "quick_prompt";
  const selectedAttachable =
    attachable?.find((entry) => entry.reviewRequest.id === selectedReviewRequestId) ?? null;
  const selectedQuickPrompt = quickPrompts?.find((prompt) => prompt.id === selectedQuickPromptId) ?? null;
  const stepsForMode = usesTextPipeline ? TASK_STEPS : TASK_STEPS.filter((step) => step !== "create_issue");
  const configByStepForMode = () => (customisePerStep ? pickConfigOverrides(stepsForMode, configByStep) : undefined);
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
    setSavedPastedText(null);
  }, [selectedRepo]);

  useEffect(() => {
    setQuickPrompts(null);
    setSelectedQuickPromptId(null);
    if (mode !== "quick_prompt" || !selectedRepo) return;

    let cancelled = false;
    fetchQuickPrompts(selectedRepo.fullName, selectedRepo.source)
      .then((prompts) => {
        if (!cancelled) setQuickPrompts(prompts);
      })
      .catch((err) => {
        if (!cancelled) setError("Failed to load quick-prompts: " + String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, selectedRepo]);

  useEffect(() => {
    setAttachable(null);
    setSelectedReviewRequestId(null);
    setSelectedAttachWorkItemId(null);
    if (mode !== "review_request" || !selectedRepo) return;

    let cancelled = false;
    fetchAttachableReviewRequests(selectedRepo.fullName, selectedRepo.source)
      .then((items) => {
        if (!cancelled) setAttachable(items);
      })
      .catch((err) => {
        if (!cancelled) setError("Failed to load open PRs/MRs: " + String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, selectedRepo]);

  const selectAttachable = (entry: AttachableReviewRequest) => {
    setSelectedReviewRequestId(entry.reviewRequest.id);
    setSelectedAttachWorkItemId(entry.workItems[0].id);
  };

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
        configByStep: configByStepForMode(),
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

  const submitTask = async (create: () => Promise<Task>) => {
    if (!selectedConfig || !selectedRepo) return;
    setWorking(true);
    setError(null);
    try {
      const task = await create();
      onCreated([task]);
      onClose();
    } catch (err) {
      setError("Failed to create task: " + String(err));
    } finally {
      setWorking(false);
    }
  };

  const handleCreateFromText = async () => {
    const text = pastedText.trim();
    if (text === "") {
      setError("Paste a description of the work first");
      return;
    }
    if (!selectedRepo) return;
    await submitTask(() =>
      createTaskFromText({
        repoFullName: selectedRepo.fullName,
        repoSource: selectedRepo.source,
        text,
        configName: selectedConfig,
        configByStep: configByStepForMode(),
      }),
    );
  };

  const handleCreateFromQuickPrompt = async () => {
    if (!selectedQuickPrompt) {
      setError("Select a quick-prompt first");
      return;
    }
    await submitTask(() =>
      launchQuickPrompt(selectedQuickPrompt.id, {
        configName: selectedConfig,
        configByStep: configByStepForMode(),
      }),
    );
  };

  const handleAttachToReviewRequest = async () => {
    if (!selectedAttachable || !selectedAttachWorkItemId) {
      setError("Select a PR/MR first");
      return;
    }
    if (!selectedRepo) return;
    await submitTask(() =>
      createTaskFromReviewRequest({
        repoFullName: selectedRepo.fullName,
        repoSource: selectedRepo.source,
        reviewRequestId: selectedAttachable.reviewRequest.id,
        workItemId: selectedAttachWorkItemId,
        configName: selectedConfig,
        configByStep: configByStepForMode(),
      }),
    );
  };

  const saveQuickPrompt = async (text: string): Promise<QuickPrompt | null> => {
    if (!selectedRepo) return null;
    setWorking(true);
    setError(null);
    try {
      return await createQuickPrompt({ repoFullName: selectedRepo.fullName, repoSource: selectedRepo.source, text });
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setWorking(false);
    }
  };

  const handleSaveNewQuickPrompt = async () => {
    const prompt = await saveQuickPrompt(newQuickPromptText.trim());
    if (!prompt) return;
    setQuickPrompts((prompts) => [...(prompts ?? []), prompt]);
    setSelectedQuickPromptId(prompt.id);
    setNewQuickPromptText("");
  };

  const handleSavePastedTextAsQuickPrompt = async () => {
    const text = pastedText.trim();
    const prompt = await saveQuickPrompt(text);
    if (prompt) setSavedPastedText(text);
  };

  const handleRemoveQuickPrompt = async (id: string) => {
    if (!selectedRepo) return;
    setWorking(true);
    setError(null);
    try {
      await deleteQuickPrompt(id);
      setQuickPrompts((prompts) => (prompts ? prompts.filter((prompt) => prompt.id !== id) : prompts));
      setSelectedQuickPromptId((selected) => (selected === id ? null : selected));
    } catch (err) {
      setError(String(err));
    } finally {
      setWorking(false);
    }
  };

  const handleSubmit = {
    text: handleCreateFromText,
    quick_prompt: handleCreateFromQuickPrompt,
    review_request: handleAttachToReviewRequest,
    work_items: handleCreate,
  }[mode];

  const submitDisabledForMode = {
    text: pastedText.trim() === "",
    quick_prompt: !selectedQuickPrompt,
    review_request: !selectedAttachable || selectedAttachable.unusableReason !== null,
    work_items: selectedCount === 0,
  }[mode];

  const submitLabel = working
    ? "Working..."
    : mode === "review_request"
      ? "Attach Task"
      : usesTextPipeline
        ? "Create Task"
        : `Create ${selectedCount} Task${selectedCount === 1 ? "" : "s"}`;

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
              Shepherds work from issue to merged PR/MR without further input.
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
              <ConfigStepPicker
                configs={configs}
                steps={stepsForMode}
                configName={selectedConfig}
                onConfigNameChange={setSelectedConfig}
                configByStep={configByStep}
                onConfigByStepChange={setConfigByStep}
                customised={customisePerStep}
                onCustomisedChange={setCustomisePerStep}
              />

              <RepoPicker
                repos={repos}
                gitlabConfigured={gitlabConfigured}
                selectedRepo={selectedRepo}
                onSelect={setSelectedRepo}
              />

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-slate-700 border border-slate-700 rounded-lg overflow-hidden">
                {TASK_MODES.map(({ mode: taskMode, label }) => (
                  <button
                    key={taskMode}
                    type="button"
                    onClick={() => setMode(taskMode)}
                    className={`px-3 py-1.5 text-xs ${mode === taskMode ? "bg-slate-700 text-slate-100" : "bg-slate-900 text-slate-400 hover:bg-slate-800"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mode === "text" ? (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500">
                    An agent first explores the repository and opens an issue from your text; the task then shepherds
                    that issue to a merged PR/MR.
                  </p>
                  <ProseTextArea
                    value={pastedText}
                    onChange={setPastedText}
                    placeholder="Describe the feature or fix..."
                    rows={8}
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleSavePastedTextAsQuickPrompt}
                      disabled={
                        !selectedRepo || working || pastedText.trim() === "" || savedPastedText === pastedText.trim()
                      }
                      className="text-xs text-slate-400 hover:text-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savedPastedText === pastedText.trim() ? "Saved as quick-prompt" : "Save as quick-prompt"}
                    </button>
                  </div>
                </div>
              ) : mode === "quick_prompt" ? (
                !selectedRepo ? (
                  <p className="text-xs text-slate-500">Select a repository first.</p>
                ) : quickPrompts === null ? (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin h-5 w-5 border-2 border-slate-500 border-t-transparent rounded-full" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-500">
                      Saved prompts for this repository. The selected prompt is used like pasted text: an agent opens an
                      issue from it, then the task shepherds that issue to a merged PR/MR.
                    </p>
                    {quickPrompts.length === 0 ? (
                      <p className="text-sm text-slate-400 border border-slate-700 rounded-lg px-3 py-2">
                        No quick-prompts saved for this repository yet.
                      </p>
                    ) : (
                      <div
                        role="radiogroup"
                        aria-label="Quick-prompts"
                        className="max-h-48 overflow-y-auto border border-slate-700 rounded-lg divide-y divide-slate-800"
                      >
                        {quickPrompts.map((prompt) => (
                          <div key={prompt.id} className="flex items-start gap-2 px-3 py-2 hover:bg-slate-800">
                            <label className="flex items-start gap-2 flex-1 min-w-0 text-sm text-slate-300 cursor-pointer">
                              <input
                                type="radio"
                                name="quick-prompt"
                                checked={selectedQuickPromptId === prompt.id}
                                onChange={() => setSelectedQuickPromptId(prompt.id)}
                                className="mt-0.5 accent-indigo-500"
                              />
                              <span className="break-words whitespace-pre-wrap min-w-0">{prompt.text}</span>
                            </label>
                            {prompt.perpetual && (
                              <span
                                title="Relaunches itself whenever its last task finishes"
                                className="shrink-0 text-[10px] uppercase tracking-wide text-indigo-200 border border-indigo-500/50 rounded px-1.5 py-0.5"
                              >
                                Perpetual
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleRemoveQuickPrompt(prompt.id)}
                              disabled={working}
                              aria-label="Remove quick-prompt"
                              className="text-slate-500 hover:text-rose-300 leading-none disabled:opacity-50"
                            >
                              &times;
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <textarea
                      value={newQuickPromptText}
                      onChange={(e) => setNewQuickPromptText(e.target.value)}
                      placeholder="New quick-prompt..."
                      aria-label="New quick-prompt"
                      rows={3}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm resize-y"
                    />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleSaveNewQuickPrompt}
                        disabled={working || newQuickPromptText.trim() === ""}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Save prompt
                      </button>
                    </div>
                  </div>
                )
              ) : mode === "review_request" ? (
                !selectedRepo ? (
                  <p className="text-xs text-slate-500">Select a repository first.</p>
                ) : attachable === null ? (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin h-5 w-5 border-2 border-slate-500 border-t-transparent rounded-full" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-500">
                      Attaches to an existing PR/MR and goes straight to review, rebase, CI fixes and comment
                      addressing — no issue or implementation step.
                    </p>
                    {attachable.length === 0 ? (
                      <p className="text-sm text-slate-400 border border-slate-700 rounded-lg px-3 py-2">
                        No open PRs/MRs that mention an open issue and are not already handled by a task.
                      </p>
                    ) : (
                      <div
                        role="radiogroup"
                        aria-label="Open PRs/MRs"
                        className="max-h-48 overflow-y-auto border border-slate-700 rounded-lg divide-y divide-slate-800"
                      >
                        {attachable.map((entry) => (
                          <label
                            key={entry.reviewRequest.id}
                            className={`flex items-start gap-2 px-3 py-2 text-sm ${entry.unusableReason ? "text-slate-500 cursor-not-allowed" : "text-slate-300 hover:bg-slate-800 cursor-pointer"}`}
                          >
                            <input
                              type="radio"
                              name="review-request"
                              checked={selectedReviewRequestId === entry.reviewRequest.id}
                              disabled={entry.unusableReason !== null}
                              onChange={() => selectAttachable(entry)}
                              className="mt-0.5 accent-indigo-500"
                            />
                            <span className="min-w-0 break-words">
                              <span>
                                {entry.reviewRequest.reference} {entry.reviewRequest.title}
                              </span>
                              <span className="block text-xs text-slate-500">
                                Mentions {entry.workItems.map((item) => item.reference).join(", ")}
                              </span>
                              {entry.unusableReason && (
                                <span className="block text-xs text-amber-300/80">{entry.unusableReason}</span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    {selectedAttachable && selectedAttachable.workItems.length > 1 && (
                      <label className="flex flex-col gap-1 text-xs text-slate-400">
                        Issue this task tracks
                        <select
                          value={selectedAttachWorkItemId ?? ""}
                          onChange={(e) => setSelectedAttachWorkItemId(e.target.value)}
                          className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm"
                        >
                          {selectedAttachable.workItems.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.reference} {item.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )
              ) : workItems === null ? (
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
            onClick={handleSubmit}
            disabled={
              !selectedConfig ||
              !selectedRepo ||
              working ||
              loading ||
              submitDisabledForMode
            }
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(NewTaskModal);
