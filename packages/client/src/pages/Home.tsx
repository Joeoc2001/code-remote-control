import { useState, useEffect, useCallback } from "react";
import type { ManagedContainer } from "../types";
import { fetchContainers, fetchContainerCodeStatus, subscribeToEvents } from "../api";
import Header from "../components/Header";
import ContainerGrid from "../components/ContainerGrid";
import NewContainerModal from "../components/NewContainerModal";
import DeleteAllModal from "../components/DeleteAllModal";
import Footer from "../components/Footer";

export default function Home() {
  const [containers, setContainers] = useState<ManagedContainer[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [taskDescriptionByContainerId, setTaskDescriptionByContainerId] = useState<Record<string, string>>({});

  const refreshTaskDescriptions = useCallback(async (containersToRefresh: ManagedContainer[], pruneMissing = false) => {
    const runningContainers = containersToRefresh.filter((container) => container.status === "running");

    const taskDescriptions = await Promise.all(
      runningContainers.map(async (container) => {
        try {
          const codeStatus = await fetchContainerCodeStatus(container.id);
          const taskDescription = codeStatus.currentTaskDescription?.trim() || null;
          return { id: container.id, taskDescription };
        } catch {
          return { id: container.id, taskDescription: null };
        }
      }),
    );

    setTaskDescriptionByContainerId((previous) => {
      const next: Record<string, string> = { ...previous };

      if (pruneMissing) {
        const activeIds = new Set(containersToRefresh.map((container) => container.id));
        for (const id of Object.keys(next)) {
          if (!activeIds.has(id)) {
            delete next[id];
          }
        }
      }

      for (const container of containersToRefresh) {
        if (container.status !== "running") {
          delete next[container.id];
        }
      }

      for (const { id, taskDescription } of taskDescriptions) {
        if (taskDescription) {
          next[id] = taskDescription;
        } else {
          delete next[id];
        }
      }

      return next;
    });
  }, []);

  const loadContainers = useCallback(async () => {
    try {
      const data = await fetchContainers();
      setContainers(data);
      void refreshTaskDescriptions(data, true);
      setError(null);
    } catch (err) {
      console.error("Failed to load containers:", err);
      setError("Failed to load containers");
    } finally {
      setLoading(false);
    }
  }, [refreshTaskDescriptions]);

  useEffect(() => {
    loadContainers();
  }, [loadContainers]);

  useEffect(() => {
    const unsubscribe = subscribeToEvents(
      (updated) => {
        setContainers((prev) => {
          const index = prev.findIndex((c) => c.id === updated.id);
          if (index >= 0) {
            const next = [...prev];
            next[index] = updated;
            return next;
          }
          return [updated, ...prev];
        });

        if (updated.status === "running") {
          void refreshTaskDescriptions([updated]);
        } else {
          setTaskDescriptionByContainerId((prev) => {
            const next = { ...prev };
            delete next[updated.id];
            return next;
          });
        }
      },
      (removedId) => {
        setContainers((prev) => prev.filter((c) => c.id !== removedId));
        setTaskDescriptionByContainerId((prev) => {
          const next = { ...prev };
          delete next[removedId];
          return next;
        });
      },
      loadContainers,
      setConnected,
    );
    return unsubscribe;
  }, [loadContainers, refreshTaskDescriptions]);

  useEffect(() => {
    if (containers.length === 0) {
      setTaskDescriptionByContainerId({});
      return;
    }

    const interval = setInterval(() => {
      void refreshTaskDescriptions(containers, true);
    }, 15000);

    return () => {
      clearInterval(interval);
    };
  }, [containers, refreshTaskDescriptions]);

  const getContainerTitle = useCallback(
    (container: ManagedContainer): string => taskDescriptionByContainerId[container.id] || container.name.replace(/^crc-/, ""),
    [taskDescriptionByContainerId],
  );

  const handleContainerCreated = (container: ManagedContainer) => {
    setContainers((prev) => {
      if (prev.some((c) => c.id === container.id)) return prev;
      return [container, ...prev];
    });
    setShowModal(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header
        onNewContainer={() => setShowModal(true)}
        onDeleteAll={() => setShowDeleteAllModal(true)}
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
              onClick={loadContainers}
              className="mt-4 px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : containers.length === 0 ? (
          <div className="text-center py-24 rounded-2xl border border-slate-800 bg-slate-900/50 text-slate-400">
            <p className="text-lg text-slate-200">No containers running</p>
            <p className="mt-2 text-sm">
              Click "New Container" to spawn a development environment.
            </p>
          </div>
        ) : (
          <ContainerGrid containers={containers} getContainerTitle={getContainerTitle} onRefresh={loadContainers} />
        )}
      </main>
      {showModal && (
        <NewContainerModal
          onClose={() => setShowModal(false)}
          onCreated={handleContainerCreated}
        />
      )}
      {showDeleteAllModal && (
        <DeleteAllModal
          onClose={() => setShowDeleteAllModal(false)}
          onDeleted={() => {
            setShowDeleteAllModal(false);
            setContainers([]);
          }}
        />
      )}
      <Footer />
    </div>
  );
}
