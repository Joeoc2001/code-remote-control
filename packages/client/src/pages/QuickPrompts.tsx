import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ConfigSummary, QuickPrompt, Task, TaskStep } from "../types";
import { TASK_STEPS } from "../types";
import {
  createQuickPrompt,
  deleteQuickPrompt,
  fetchAllQuickPrompts,
  fetchConfigs,
  fetchGitHubRepos,
  fetchGitLabRepos,
  fetchTasks,
  launchQuickPrompt,
  subscribeToEvents,
  updateQuickPrompt,
} from "../api";
import Header from "../components/Header";
import Footer from "../components/Footer";
import RepoPicker, { type RepoEntry } from "../components/RepoPicker";
import ConfigStepPicker, { pickConfigOverrides } from "../components/ConfigStepPicker";
import TaskPhaseBadge from "../components/TaskPhaseBadge";
import { TASK_STEP_LABELS } from "../components/taskStepLabels";
import { taskTitle } from "../components/taskTitle";

function repoKey(repo: { repoSource: string; repoFullName: string }): string {
  return `${repo.repoSource}:${repo.repoFullName}`;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function configDraftFrom(prompt: QuickPrompt, fallback: string) {
  const configName = prompt.configByStep?.create_issue ?? fallback;
  return {
    configName,
    configByStep: Object.fromEntries(
      TASK_STEPS.flatMap((step) =>
        prompt.configByStep && prompt.configByStep[step] !== configName ? [[step, prompt.configByStep[step]]] : [],
      ),
    ) as Partial<Record<TaskStep, string>>,
  };
}

function describeConfig(configByStep: Record<TaskStep, string> | null): string {
  if (!configByStep) return "No configuration stored yet";
  const base = configByStep.create_issue;
  const overrides = TASK_STEPS.filter((step) => configByStep[step] !== base).map(
    (step) => `${TASK_STEP_LABELS[step]}: ${configByStep[step]}`,
  );
  return overrides.length === 0 ? base : `${base} (${overrides.join(", ")})`;
}

function blockReason(prompt: QuickPrompt, lastInstance: Task | null): string | null {
  if (!prompt.perpetual) return null;
  if (lastInstance && lastInstance.phase === "failed") {
    return "Blocked: the last task failed — resume or delete it to continue";
  }
  if (lastInstance && lastInstance.phase === "paused") {
    return "Blocked: the last task is paused — resume it to continue";
  }
  if (lastInstance && lastInstance.phase !== "merged") {
    return "Relaunches once the current task has merged and its issue is closed";
  }
  if (prompt.reviewRequestIds.length > 0) {
    return `Waiting for open PR/MR ${prompt.reviewRequestIds.map((id) => `#${id}`).join(", ")} to close`;
  }
  return "Launching on the next scheduler tick";
}

interface QuickPromptRowProps {
  prompt: QuickPrompt;
  instances: Task[];
  configs: ConfigSummary[];
  highlighted: boolean;
  onPromptChanged: (prompt: QuickPrompt) => void;
  onPromptRemoved: (id: string) => void;
  onTaskCreated: (task: Task) => void;
}

function QuickPromptRow({
  prompt,
  instances,
  configs,
  highlighted,
  onPromptChanged,
  onPromptRemoved,
  onTaskCreated,
}: QuickPromptRowProps) {
  const fallbackConfig = configs[0]?.name ?? "";
  const storedConfigKey = JSON.stringify(prompt.configByStep);
  const [draft, setDraft] = useState(() => configDraftFrom(prompt, fallbackConfig));
  const [customised, setCustomised] = useState(() => Object.keys(draft.configByStep).length > 0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(configDraftFrom(prompt, fallbackConfig));
  }, [storedConfigKey, fallbackConfig]);

  const lastInstance = instances[0] ?? null;
  const reason = blockReason(prompt, lastInstance);
  const configRequest = () => ({
    configName: draft.configName,
    configByStep: customised ? pickConfigOverrides(TASK_STEPS, draft.configByStep) : {},
  });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePerpetual = () =>
    run(async () => {
      onPromptChanged(
        await updateQuickPrompt(
          prompt.id,
          prompt.perpetual ? { perpetual: false } : { perpetual: true, ...configRequest() },
        ),
      );
    });

  const handleSaveConfig = () =>
    run(async () => {
      onPromptChanged(await updateQuickPrompt(prompt.id, configRequest()));
    });

  const handleLaunch = () =>
    run(async () => {
      onTaskCreated(await launchQuickPrompt(prompt.id, configRequest()));
    });

  const handleDelete = () =>
    run(async () => {
      if (!confirm(`Delete quick-prompt "${prompt.text.split("\n")[0]}"?`)) return;
      await deleteQuickPrompt(prompt.id);
      onPromptRemoved(prompt.id);
    });

  const buttonClass =
    "px-2.5 py-1 text-xs text-slate-300 hover:text-slate-100 border border-slate-700 hover:bg-slate-800 rounded-md transition-colors disabled:opacity-50";

  return (
    <article
      id={prompt.id}
      aria-label={prompt.text}
      className={`rounded-xl border bg-slate-900/70 p-4 flex flex-col gap-3 ${
        highlighted ? "border-indigo-500" : "border-slate-800/80"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-100 whitespace-pre-wrap break-words min-w-0">{prompt.text}</p>
        <label className="flex shrink-0 items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            role="switch"
            aria-label="Perpetual"
            checked={prompt.perpetual}
            disabled={busy}
            onChange={handleTogglePerpetual}
            className="accent-indigo-500"
          />
          Perpetual
        </label>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-slate-500">Configuration</dt>
        <dd className="text-slate-300 break-words" data-testid="stored-config">
          {describeConfig(prompt.configByStep)}
        </dd>
        <dt className="text-slate-500">Last task</dt>
        <dd className="text-slate-300 min-w-0">
          {lastInstance ? (
            <span className="flex flex-wrap items-center gap-2">
              <Link to={`/tasks/${lastInstance.id}`} className="text-indigo-300 hover:text-indigo-200 truncate">
                {taskTitle(lastInstance)}
              </Link>
              <TaskPhaseBadge phase={lastInstance.phase} />
            </span>
          ) : (
            "None"
          )}
        </dd>
        <dt className="text-slate-500">Last launched</dt>
        <dd className="text-slate-300">
          {prompt.lastLaunchedAt ? new Date(prompt.lastLaunchedAt).toLocaleString() : "Never"}
        </dd>
      </dl>

      {reason && <p className="text-xs text-indigo-200">{reason}</p>}
      {prompt.error && (
        <p className="text-xs text-rose-300 bg-rose-900/20 border border-rose-800 rounded-lg px-2.5 py-1.5 break-words">
          {prompt.error}
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="text-xs text-rose-300 bg-rose-900/20 border border-rose-800 rounded-lg px-2.5 py-1.5 break-words"
        >
          {actionError}
        </p>
      )}

      <details>
        <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">Edit configuration</summary>
        <div className="mt-2 space-y-2">
          <ConfigStepPicker
            configs={configs}
            steps={TASK_STEPS}
            configName={draft.configName}
            onConfigNameChange={(configName) => setDraft((prev) => ({ ...prev, configName }))}
            configByStep={draft.configByStep}
            onConfigByStepChange={(configByStep) => setDraft((prev) => ({ ...prev, configByStep }))}
            initiallyCustomised={customised}
            onCustomisedChange={setCustomised}
          />
          <button type="button" onClick={handleSaveConfig} disabled={busy || !draft.configName} className={buttonClass}>
            Save configuration
          </button>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={handleLaunch} disabled={busy || !draft.configName} className={buttonClass}>
          Launch now
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          className="px-2.5 py-1 text-xs text-rose-300 hover:text-rose-100 border border-rose-900/80 hover:bg-rose-500/20 rounded-md transition-colors disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </article>
  );
}

export default function QuickPrompts() {
  const { hash } = useLocation();
  const highlightedId = hash ? decodeURIComponent(hash.slice(1)) : null;
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [gitlabConfigured, setGitlabConfigured] = useState(false);
  const [repoFilter, setRepoFilter] = useState<RepoEntry | null>(null);
  const [newPromptText, setNewPromptText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  const load = useCallback(async () => {
    try {
      const [promptData, taskData, configData, githubRepos, gitlabData] = await Promise.all([
        fetchAllQuickPrompts(),
        fetchTasks(),
        fetchConfigs(),
        fetchGitHubRepos(),
        fetchGitLabRepos(),
      ]);
      setPrompts(promptData);
      setTasks(taskData);
      setConfigs(configData);
      setGitlabConfigured(gitlabData.configured);
      setRepos([
        ...githubRepos.map((r) => ({ fullName: r.fullName, description: r.description, source: "github" as const })),
        ...gitlabData.repos.map((r) => ({ fullName: r.fullName, description: r.description, source: "gitlab" as const })),
      ]);
      setError(null);
    } catch (err) {
      console.error("Failed to load quick-prompts:", err);
      setError("Failed to load quick-prompts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upsertPrompt = useCallback((prompt: QuickPrompt) => setPrompts((prev) => upsertById(prev, prompt)), []);
  const removePrompt = useCallback((id: string) => setPrompts((prev) => prev.filter((p) => p.id !== id)), []);
  const upsertTask = useCallback((task: Task) => setTasks((prev) => upsertById(prev, task)), []);
  const removeTask = useCallback((id: string) => setTasks((prev) => prev.filter((t) => t.id !== id)), []);

  useEffect(
    () =>
      subscribeToEvents({
        onQuickPromptUpdated: upsertPrompt,
        onQuickPromptRemoved: removePrompt,
        onTaskUpdated: upsertTask,
        onTaskRemoved: removeTask,
        onReconnect: load,
        onConnectionError: setConnected,
      }),
    [load, upsertPrompt, removePrompt, upsertTask, removeTask],
  );

  useEffect(() => {
    if (!loading && highlightedId) document.getElementById(highlightedId)?.scrollIntoView({ block: "center" });
  }, [loading, highlightedId]);

  const instancesByPrompt = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.quickPromptId === null) continue;
      grouped.set(task.quickPromptId, [...(grouped.get(task.quickPromptId) ?? []), task]);
    }
    for (const list of grouped.values()) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return grouped;
  }, [tasks]);

  const groups = useMemo(() => {
    const byRepo = new Map<string, QuickPrompt[]>();
    for (const prompt of prompts) {
      if (repoFilter && repoKey(prompt) !== `${repoFilter.source}:${repoFilter.fullName}`) continue;
      byRepo.set(repoKey(prompt), [...(byRepo.get(repoKey(prompt)) ?? []), prompt]);
    }
    return [...byRepo.values()].sort((a, b) => a[0].repoFullName.localeCompare(b[0].repoFullName));
  }, [prompts, repoFilter]);

  const handleAddPrompt = async () => {
    if (!repoFilter) return;
    setAdding(true);
    setAddError(null);
    try {
      upsertPrompt(
        await createQuickPrompt({
          repoFullName: repoFilter.fullName,
          repoSource: repoFilter.source,
          text: newPromptText.trim(),
        }),
      );
      setNewPromptText("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header />
      {!connected && (
        <div className="bg-amber-900/40 border-b border-amber-700/60 px-4 py-2 text-center text-amber-200 text-sm">
          Connection lost — reconnecting...
        </div>
      )}
      <main className="max-w-7xl mx-auto px-4 py-8 space-y-6">
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin h-8 w-8 border-2 border-slate-500 border-t-transparent rounded-full" />
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <p className="text-rose-300 text-lg">{error}</p>
            <button
              onClick={load}
              className="mt-4 px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
              <RepoPicker
                repos={repos}
                gitlabConfigured={gitlabConfigured}
                selectedRepo={repoFilter}
                onSelect={setRepoFilter}
              />
              {repoFilter && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setRepoFilter(null)}
                    className="text-xs text-slate-400 hover:text-slate-100"
                  >
                    Show all repositories
                  </button>
                  <textarea
                    value={newPromptText}
                    onChange={(e) => setNewPromptText(e.target.value)}
                    placeholder={`New quick-prompt for ${repoFilter.fullName}...`}
                    aria-label="New quick-prompt"
                    rows={3}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-base sm:text-sm resize-y"
                  />
                  {addError && <p className="text-xs text-rose-300">{addError}</p>}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleAddPrompt}
                      disabled={adding || newPromptText.trim() === ""}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Save prompt
                    </button>
                  </div>
                </div>
              )}
            </section>

            {groups.length === 0 ? (
              <div className="text-center py-24 rounded-2xl border border-slate-800 bg-slate-900/50 text-slate-400">
                <p className="text-lg text-slate-200">No quick-prompts yet</p>
                <p className="mt-2 text-sm">
                  {repoFilter
                    ? `Save a quick-prompt for ${repoFilter.fullName} above.`
                    : "Pick a repository to save one, or save one from the New Task dialog."}
                </p>
              </div>
            ) : (
              groups.map((group) => (
                <section key={repoKey(group[0])} aria-label={group[0].repoFullName} className="space-y-3">
                  <h2 className="text-sm font-semibold text-slate-300">
                    <span className="mr-2 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">
                      {group[0].repoSource === "gitlab" ? "GL" : "GH"}
                    </span>
                    {group[0].repoFullName}
                  </h2>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {group.map((prompt) => (
                      <QuickPromptRow
                        key={prompt.id}
                        prompt={prompt}
                        instances={instancesByPrompt.get(prompt.id) ?? []}
                        configs={configs}
                        highlighted={prompt.id === highlightedId}
                        onPromptChanged={upsertPrompt}
                        onPromptRemoved={removePrompt}
                        onTaskCreated={upsertTask}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
