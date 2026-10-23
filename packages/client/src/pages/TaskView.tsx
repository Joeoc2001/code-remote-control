import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { currentStageFirstAttemptIndex, type Task, type TaskAttempt, type TaskStage } from "../types";
import { deleteTask, fetchTask, fetchTaskAttemptLog, subscribeToEvents, updateTask } from "../api";
import Header from "../components/Header";
import Footer from "../components/Footer";
import TaskPhaseBadge from "../components/TaskPhaseBadge";
import QuickPromptBadge from "../components/QuickPromptBadge";
import ReviewRequestBadge from "../components/ReviewRequestBadge";
import WorkItemBadge from "../components/WorkItemBadge";
import { TASK_STEP_LABELS } from "../components/taskStepLabels";
import { taskTitle } from "../components/taskTitle";
import { taskWorkItemBadge } from "../components/taskWorkItemBadge";

function SourceText({ text }: { text: string }) {
  return (
    <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs text-slate-300 whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatDuration(startedAt: string, finishedAt: string): string {
  const totalSeconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatTimeAgo(value: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function PokeSummary({ attempt }: { attempt: TaskAttempt }) {
  if (attempt.pokeCount === 0 || attempt.lastPokedAt === null) return null;
  return (
    <span
      className="text-xs text-amber-300/90"
      title={`Nudged by the scheduler after it stalled; last poke ${formatTimestamp(attempt.lastPokedAt)}`}
    >
      Poked {attempt.pokeCount}× · last {formatTimeAgo(attempt.lastPokedAt, Date.now())}
    </span>
  );
}

interface AttemptRowProps {
  taskId: string;
  attempt: TaskAttempt;
  index: number;
  isActive: boolean;
  activeContainerId: string | null;
}

function AttemptRow({ taskId, attempt, index, isActive, activeContainerId }: AttemptRowProps) {
  const isHeld = isActive && attempt.error !== null;
  const [log, setLog] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);

  const handleToggleLog = async () => {
    if (showLog) {
      setShowLog(false);
      return;
    }
    setShowLog(true);
    if (log !== null) return;
    setLoadingLog(true);
    setLogError(null);
    try {
      setLog(await fetchTaskAttemptLog(taskId, index));
    } catch (err) {
      setLogError("Failed to load captured log: " + String(err));
    } finally {
      setLoadingLog(false);
    }
  };

  return (
    <li className="rounded-xl border border-slate-800/80 bg-slate-900/70 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          #{index + 1}
        </span>
        <span className="text-sm font-medium text-slate-100">{TASK_STEP_LABELS[attempt.step]}</span>
        {isHeld ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-800/80 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-300" />
            Held
          </span>
        ) : isActive ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-800/80 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-300 animate-pulse" />
            Running
          </span>
        ) : attempt.error ? (
          <span className="inline-flex items-center rounded-full border border-rose-800/80 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-300">
            Failed
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-emerald-800/80 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
            Completed
          </span>
        )}
        <span className="text-xs text-slate-500">
          {formatTimestamp(attempt.startedAt)}
          {attempt.finishedAt && ` · ${formatDuration(attempt.startedAt, attempt.finishedAt)}`}
        </span>
        <PokeSummary attempt={attempt} />
        <div className="ml-auto flex items-center gap-2">
          {isActive && activeContainerId && (
            <Link
              to={`/view/${activeContainerId}`}
              className="px-2.5 py-1 text-xs text-slate-300 hover:text-slate-100 border border-slate-700 hover:bg-slate-800 rounded-md transition-colors"
            >
              Terminal
            </Link>
          )}
          {(!isActive || isHeld) && (
            <button
              onClick={handleToggleLog}
              className="px-2.5 py-1 text-xs text-slate-300 hover:text-slate-100 border border-slate-700 hover:bg-slate-800 rounded-md transition-colors"
            >
              {showLog ? "Hide log" : "Show log"}
            </button>
          )}
        </div>
      </div>
      {attempt.error && (
        <p className="mt-2 text-xs text-rose-300 break-words">{attempt.error}</p>
      )}
      {showLog && (
        <div className="mt-3">
          {loadingLog ? (
            <div className="flex justify-center py-4">
              <div className="animate-spin h-5 w-5 border-2 border-slate-500 border-t-transparent rounded-full" />
            </div>
          ) : logError ? (
            <p className="text-xs text-rose-300">{logError}</p>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs text-slate-300 whitespace-pre-wrap break-words">
              {log}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

function AttemptList({ task, firstIndex, count }: { task: Task; firstIndex: number; count: number }) {
  const indices = Array.from({ length: count }, (_, offset) => firstIndex + offset);
  return (
    <ul className="space-y-3">
      {indices.map((index) => (
        <AttemptRow
          key={index}
          taskId={task.id}
          attempt={task.attempts[index]}
          index={index}
          isActive={
            task.attempts[index].finishedAt === null &&
            index === task.attempts.length - 1 &&
            task.activeContainerId !== null
          }
          activeContainerId={task.activeContainerId}
        />
      ))}
    </ul>
  );
}

function CompletedStage({ task, stage, number }: { task: Task; stage: TaskStage; number: number }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-slate-200">Stage {number}</h3>
        <ReviewRequestBadge url={stage.reviewRequest.url} id={stage.reviewRequest.id} state="merged" />
        <span className="text-xs text-slate-500">
          {formatTimestamp(stage.startedAt)} → merged {formatTimestamp(stage.mergedAt)}
        </span>
      </div>
      <AttemptList task={task} firstIndex={stage.firstAttemptIndex} count={stage.attemptCount} />
    </div>
  );
}

function PreviousStages({ task }: { task: Task }) {
  return (
    <details className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5">
      <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200">
        Previous stages ({task.completedStages.length})
      </summary>
      <div className="mt-4 space-y-6">
        {task.completedStages.map((stage, index) => (
          <CompletedStage key={index} task={task} stage={stage} number={index + 1} />
        ))}
      </div>
    </details>
  );
}

export default function TaskView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTask = useCallback(async () => {
    if (!id) return;
    try {
      setTask(await fetchTask(id));
      setError(null);
    } catch (err) {
      console.error("Failed to load task:", err);
      setError("Failed to load task");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadTask();
  }, [loadTask]);

  useEffect(() => {
    const unsubscribe = subscribeToEvents({
      onTaskUpdated: (updated) => {
        if (updated.id === id) setTask(updated);
      },
      onTaskRemoved: (removedId) => {
        if (removedId === id) navigate("/tasks");
      },
      onReconnect: loadTask,
    });
    return unsubscribe;
  }, [id, loadTask, navigate]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      console.error("Task action failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const currentStageFirstIndex = task ? currentStageFirstAttemptIndex(task) : 0;
  const currentStageAttemptCount = task ? task.attempts.length - currentStageFirstIndex : 0;
  const workItemBadge = task ? taskWorkItemBadge(task) : null;

  const actionButtonClass =
    "px-3 py-1.5 text-sm text-slate-300 hover:text-slate-100 border border-slate-700 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header />
      <main className="max-w-4xl mx-auto px-4 py-8">
        <Link to="/tasks" className="text-sm text-slate-400 hover:text-slate-100 transition-colors">
          &larr; All tasks
        </Link>
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin h-8 w-8 border-2 border-slate-500 border-t-transparent rounded-full" />
          </div>
        ) : error || !task ? (
          <div className="text-center py-20">
            <p className="text-rose-300 text-lg">{error ?? "Task not found"}</p>
          </div>
        ) : (
          <div className="mt-4 space-y-6">
            {task.completedStages.length > 0 && <PreviousStages task={task} />}
            <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="text-lg font-semibold text-slate-100">
                    {task.workItem ? (
                      <a
                        href={task.workItem.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {taskTitle(task)}
                      </a>
                    ) : (
                      taskTitle(task)
                    )}
                  </h1>
                  <p className="text-sm text-slate-400 mt-1">{task.repoFullName}</p>
                </div>
                <div className="flex items-center gap-2">
                  {task.phase !== "merged" && task.phase !== "failed" && task.phase !== "paused" && (
                    <button
                      onClick={() =>
                        runAction(async () => setTask(await updateTask(task.id, { phase: "paused" })))
                      }
                      disabled={busy}
                      className={actionButtonClass}
                    >
                      Pause
                    </button>
                  )}
                  {(task.phase === "paused" || task.phase === "failed") && (
                    <button
                      onClick={() =>
                        runAction(async () => setTask(await updateTask(task.id, { phase: "resume" })))
                      }
                      disabled={busy}
                      className={actionButtonClass}
                    >
                      {task.phase === "paused" ? "Resume" : task.activeContainerId ? "Retry with same agent" : "Retry"}
                    </button>
                  )}
                  {task.phase === "failed" && task.activeContainerId && (
                    <button
                      onClick={() =>
                        runAction(async () =>
                          setTask(await updateTask(task.id, { phase: "resume", discardContainer: true })),
                        )
                      }
                      disabled={busy}
                      className={actionButtonClass}
                    >
                      Discard &amp; retry
                    </button>
                  )}
                  <button
                    onClick={() =>
                      runAction(async () => {
                        if (!confirm(`Delete task "${taskTitle(task)}"?`)) return;
                        await deleteTask(task.id);
                        navigate("/tasks");
                      })
                    }
                    disabled={busy}
                    className="px-3 py-1.5 text-sm text-rose-300 hover:text-rose-100 border border-rose-900/80 hover:bg-rose-500/20 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <TaskPhaseBadge phase={task.phase} />
                {task.quickPromptId && <QuickPromptBadge quickPromptId={task.quickPromptId} />}
                {task.activeStep && (
                  <span className="inline-flex items-center rounded-full border border-slate-700/80 bg-slate-800/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-300">
                    {TASK_STEP_LABELS[task.activeStep]}
                  </span>
                )}
                {workItemBadge && <WorkItemBadge {...workItemBadge} />}
                {task.reviewRequest && (
                  <ReviewRequestBadge
                    url={task.reviewRequest.url}
                    id={task.reviewRequest.id}
                    state={task.phase === "merged" || task.phase === "checking_closure" ? "merged" : "open"}
                  />
                )}
              </div>
              {task.sourceText && !task.workItem && <SourceText text={task.sourceText} />}
              {task.sourceText && task.workItem && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
                    Original request
                  </summary>
                  <SourceText text={task.sourceText} />
                </details>
              )}
              {task.error && (
                <p className="mt-3 text-sm text-rose-300 bg-rose-900/20 border border-rose-800 rounded-lg px-3 py-2 break-words">
                  {task.error}
                </p>
              )}
            </div>

            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400 mb-3">
                {task.completedStages.length > 0 ? `Stage ${task.completedStages.length + 1} attempts` : "Attempts"}
              </h2>
              {currentStageAttemptCount === 0 ? (
                <p className="text-sm text-slate-500">No agents have been spawned yet.</p>
              ) : (
                <AttemptList task={task} firstIndex={currentStageFirstIndex} count={currentStageAttemptCount} />
              )}
            </section>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
