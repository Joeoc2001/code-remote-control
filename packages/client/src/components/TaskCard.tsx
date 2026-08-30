import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Task } from "../types";
import { deleteTask, updateTask } from "../api";
import TaskPhaseBadge from "./TaskPhaseBadge";
import ReviewRequestStatusIcon from "./ReviewRequestStatusIcon";
import { TASK_STEP_LABELS } from "./taskStepLabels";
import { taskTitle } from "./taskTitle";

interface TaskCardProps {
  task: Task;
  onChanged: (task: Task) => void;
  onRemoved: (id: string) => void;
}

export default function TaskCard({ task, onChanged, onRemoved }: TaskCardProps) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const reviewRequestState = task.phase === "merged" ? "merged" : "open";

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

  const handlePause = () =>
    runAction(async () => {
      onChanged(await updateTask(task.id, { phase: "paused" }));
    });

  const handleResume = () =>
    runAction(async () => {
      onChanged(await updateTask(task.id, { phase: "resume" }));
    });

  const handleDelete = () =>
    runAction(async () => {
      if (!confirm(`Delete task "${taskTitle(task)}"?`)) return;
      await deleteTask(task.id);
      onRemoved(task.id);
    });

  const canPause = task.phase !== "merged" && task.phase !== "failed" && task.phase !== "paused";
  const canResume = task.phase === "paused";
  const canRetry = task.phase === "failed";

  const actionButtonClass =
    "px-2.5 py-1 text-xs text-slate-300 hover:text-slate-100 border border-slate-700 hover:bg-slate-800 rounded-md transition-colors disabled:opacity-50";

  return (
    <article
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/tasks/${task.id}`)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate(`/tasks/${task.id}`);
        }
      }}
      className="relative cursor-pointer rounded-2xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-[0_18px_45px_-28px_rgba(0,0,0,0.9)] backdrop-blur-sm flex flex-col gap-3 transition-colors hover:border-slate-600/80"
    >
      <div className="min-w-0">
        <h3 className="text-slate-100 font-semibold truncate" title={taskTitle(task)}>
          {taskTitle(task)}
        </h3>
        <p className="text-slate-400 text-sm mt-1 truncate" title={task.repoFullName}>
          {task.repoFullName}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TaskPhaseBadge phase={task.phase} />
        {task.activeStep && (
          <span className="inline-flex items-center rounded-full border border-slate-700/80 bg-slate-800/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-300">
            {TASK_STEP_LABELS[task.activeStep]}
          </span>
        )}
        {task.reviewRequest && (
          <a
            href={task.reviewRequest.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-700/80 bg-slate-800/60 px-2 py-1 text-xs text-slate-200 hover:border-slate-500 hover:text-white transition-colors"
          >
            <ReviewRequestStatusIcon state={reviewRequestState} />
            <span className="truncate">PR/MR #{task.reviewRequest.id}</span>
          </a>
        )}
      </div>

      {task.error && (
        <p className="text-xs text-rose-300 bg-rose-900/20 border border-rose-800 rounded-lg px-2.5 py-1.5 break-words">
          {task.error}
        </p>
      )}

      <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        {task.activeContainerId && (
          <Link to={`/view/${task.activeContainerId}`} className={actionButtonClass}>
            Terminal
          </Link>
        )}
        {canPause && (
          <button onClick={handlePause} disabled={busy} className={actionButtonClass}>
            Pause
          </button>
        )}
        {canResume && (
          <button onClick={handleResume} disabled={busy} className={actionButtonClass}>
            Resume
          </button>
        )}
        {canRetry && (
          <button onClick={handleResume} disabled={busy} className={actionButtonClass}>
            Retry
          </button>
        )}
        <button
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
