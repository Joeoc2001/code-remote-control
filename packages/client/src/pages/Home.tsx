import { useState, useEffect, useCallback } from "react";
import type { ManagedContainer, ReviewRequestStatus } from "../types";
import { fetchContainers, fetchContainerCodeStatus, subscribeToEvents } from "../api";
import Header from "../components/Header";
import ContainerGrid from "../components/ContainerGrid";
import NewContainerModal from "../components/NewContainerModal";
import DeleteAllModal from "../components/DeleteAllModal";
import Footer from "../components/Footer";

const TASK_DESCRIPTION_REFRESH_INTERVAL_MS = 15000;
const EAGER_TASK_DESCRIPTION_REFRESH_INTERVAL_MS = 3000;

interface ContainerTileMetadata {
  taskDescription: string | null;
  reviewRequest: ReviewRequestStatus | null;
}

export default function Home() {
  const [containers, setContainers] = useState<ManagedContainer[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [metadataByContainerId, setMetadataByContainerId] = useState<Record<string, ContainerTileMetadata>>({});

  const refreshContainerMetadata = useCallback(async (containersToRefresh: ManagedContainer[], pruneMissing = false) => {
    const runningContainers = containersToRefresh.filter((container) => container.status === "running");

    const metadataEntries = await Promise.all(
      runningContainers.map(async (container) => {
        try {
          const codeStatus = await fetchContainerCodeStatus(container.id);
          const taskDescription = codeStatus.currentTaskDescription?.trim() || null;
          return {
            id: container.id,
            metadata: {
              taskDescription,
              reviewRequest: codeStatus.reviewRequest,
            },
          };
        } catch {
          return {
            id: container.id,
            metadata: {
              taskDescription: null,
              reviewRequest: null,
            },
          };
        }
      }),
    );

    setMetadataByContainerId((previous) => {
      const next: Record<string, ContainerTileMetadata> = { ...previous };

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

      for (const { id, metadata } of metadataEntries) {
        if (metadata.taskDescription || metadata.reviewRequest) {
          next[id] = metadata;
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
      void refreshContainerMetadata(data, true);
      setError(null);
    } catch (err) {
      console.error("Failed to load containers:", err);
      setError("Failed to load containers");
    } finally {
      setLoading(false);
    }
  }, [refreshContainerMetadata]);

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
          void refreshContainerMetadata([updated]);
        } else {
          setMetadataByContainerId((prev) => {
            const next = { ...prev };
            delete next[updated.id];
            return next;
          });
        }
      },
      (removedId) => {
        setContainers((prev) => prev.filter((c) => c.id !== removedId));
        setMetadataByContainerId((prev) => {
          const next = { ...prev };
          delete next[removedId];
          return next;
        });
      },
      loadContainers,
      setConnected,
    );
    return unsubscribe;
  }, [loadContainers, refreshContainerMetadata]);

  useEffect(() => {
    if (containers.length === 0) {
      setMetadataByContainerId({});
      return;
    }

    const interval = setInterval(() => {
      void refreshContainerMetadata(containers, true);
    }, TASK_DESCRIPTION_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [containers, refreshContainerMetadata]);

  useEffect(() => {
    const pendingContainers = containers.filter(
      (container) => container.status === "running" && !metadataByContainerId[container.id]?.taskDescription,
    );

    if (pendingContainers.length === 0) {
      return;
    }

    void refreshContainerMetadata(pendingContainers);

    const interval = setInterval(() => {
      void refreshContainerMetadata(pendingContainers);
    }, EAGER_TASK_DESCRIPTION_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [containers, refreshContainerMetadata, metadataByContainerId]);

  const getContainerTitle = useCallback(
    (container: ManagedContainer): string => metadataByContainerId[container.id]?.taskDescription || container.name.replace(/^crc-/, ""),
    [metadataByContainerId],
  );

  const handleContainerCreated = (container: ManagedContainer) => {
    setContainers((prev) => {
      if (prev.some((c) => c.id === container.id)) return prev;
      return [container, ...prev];
    });
    if (container.status === "running") {
      void refreshContainerMetadata([container]);
    }
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
          <ContainerGrid
            containers={containers}
            getContainerTitle={getContainerTitle}
            getContainerReviewRequest={(container) => metadataByContainerId[container.id]?.reviewRequest || null}
            onRefresh={loadContainers}
          />
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
