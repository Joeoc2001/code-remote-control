import { useState, useEffect, useCallback } from "react";
import type { Task } from "../types";
import { fetchTasks, subscribeToEvents } from "../api";
import Header from "../components/Header";
import TaskCard from "../components/TaskCard";
import NewTaskModal from "../components/NewTaskModal";
import Footer from "../components/Footer";

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  const loadTasks = useCallback(async () => {
    try {
      const data = await fetchTasks();
      setTasks(data);
      setError(null);
    } catch (err) {
      console.error("Failed to load tasks:", err);
      setError("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const upsertTask = useCallback((updated: Task) => {
    setTasks((prev) => {
      const index = prev.findIndex((t) => t.id === updated.id);
      if (index >= 0) {
        const next = [...prev];
        next[index] = updated;
        return next;
      }
      return [updated, ...prev];
    });
  }, []);

  const removeTask = useCallback((removedId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== removedId));
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToEvents({
      onTaskUpdated: upsertTask,
      onTaskRemoved: removeTask,
      onReconnect: loadTasks,
      onConnectionError: setConnected,
    });
    return unsubscribe;
  }, [loadTasks, upsertTask, removeTask]);

  const handleTasksCreated = (createdTasks: Task[]) => {
    setTasks((prev) => {
      const existingIds = new Set(prev.map((task) => task.id));
      const newTasks = createdTasks.filter((task) => !existingIds.has(task.id));
      if (newTasks.length === 0) return prev;
      return [...newTasks, ...prev];
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header
        actions={
          <button
            onClick={() => setShowModal(true)}
            className="px-3.5 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg text-sm font-semibold transition-colors border border-slate-600"
          >
            New Task
          </button>
        }
      />
      {!connected && (
        <div className="bg-amber-900/40 border-b border-amber-700/60 px-4 py-2 text-center text-amber-200 text-sm">
          Connection lost — reconnecting...
        </div>
      )}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin h-8 w-8 border-2 border-slate-500 border-t-transparent rounded-full" />
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <p className="text-rose-300 text-lg">{error}</p>
            <button
              onClick={loadTasks}
              className="mt-4 px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-24 rounded-2xl border border-slate-800 bg-slate-900/50 text-slate-400">
            <p className="text-lg text-slate-200">No tasks yet</p>
            <p className="mt-2 text-sm">
              Click "New Task" to shepherd a work item from issue to merged PR/MR.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} onChanged={upsertTask} onRemoved={removeTask} />
            ))}
          </div>
        )}
      </main>
      {showModal && (
        <NewTaskModal onClose={() => setShowModal(false)} onCreated={handleTasksCreated} />
      )}
      <Footer />
    </div>
  );
}
