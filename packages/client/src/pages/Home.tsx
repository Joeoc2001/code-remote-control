import { useState, useEffect, useCallback } from "react";
import type { ManagedContainer, ReviewRequestStatus } from "../types";
import {
  fetchContainers,
  fetchContainerCodeStatus,
  fetchContainerInstanceStatus,
  subscribeToEvents,
  deleteAllContainers,
  deleteFinishedContainers,
} from "../api";
import usePolledContainerData from "../hooks/usePolledContainerData";
import Header from "../components/Header";
import ContainerGrid from "../components/ContainerGrid";
import NewContainerModal from "../components/NewContainerModal";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import Footer from "../components/Footer";

const TASK_DESCRIPTION_REFRESH_INTERVAL_MS = 15000;
const EAGER_TASK_DESCRIPTION_REFRESH_INTERVAL_MS = 3000;
const INSTANCE_STATUS_REFRESH_INTERVAL_MS = 5000;

interface ContainerTileMetadata {
  taskDescription: string | null;
  reviewRequest: ReviewRequestStatus | null;
}

async function fetchContainerTileMetadata(containerId: string): Promise<ContainerTileMetadata | null> {
  const codeStatus = await fetchContainerCodeStatus(containerId);
  const taskDescription = codeStatus.currentTaskDescription?.trim() || null;
  if (!taskDescription && !codeStatus.reviewRequest) return null;
  return { taskDescription, reviewRequest: codeStatus.reviewRequest };
}

export default function Home() {
  const [containers, setContainers] = useState<ManagedContainer[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [deleteScope, setDeleteScope] = useState<"all" | "finished" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  const [metadataByContainerId, refreshContainerMetadata] = usePolledContainerData(
    containers,
    fetchContainerTileMetadata,
    TASK_DESCRIPTION_REFRESH_INTERVAL_MS,
  );
  const [instanceStatusByContainerId, refreshInstanceStatuses] = usePolledContainerData(
    containers,
    fetchContainerInstanceStatus,
    INSTANCE_STATUS_REFRESH_INTERVAL_MS,
  );

  const loadContainers = useCallback(async () => {
    try {
      const data = await fetchContainers();
      setContainers(data);
      void refreshContainerMetadata(data);
      void refreshInstanceStatuses(data);
      setError(null);
    } catch (err) {
      console.error("Failed to load containers:", err);
      setError("Failed to load containers");
    } finally {
      setLoading(false);
    }
  }, [refreshContainerMetadata, refreshInstanceStatuses]);

  useEffect(() => {
    loadContainers();
  }, [loadContainers]);

  useEffect(() => {
    const unsubscribe = subscribeToEvents({
      onContainerUpdated: (updated) => {
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
          void refreshInstanceStatuses([updated]);
        }
      },
      onContainerRemoved: (removedId) => {
        setContainers((prev) => prev.filter((c) => c.id !== removedId));
      },
      onReconnect: loadContainers,
      onConnectionError: setConnected,
    });
    return unsubscribe;
  }, [loadContainers, refreshContainerMetadata, refreshInstanceStatuses]);

  useEffect(() => {
    const pendingContainers = containers.filter(
      (container) => container.status === "running" && !metadataByContainerId[container.id]?.taskDescription,
    );

    if (pendingContainers.length === 0) {
      return;
    }

    void refreshContainerMetadata(pendingContainers);

    const interval = setInterval(() => {
      if (document.hidden) return;
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

  const handleContainersCreated = (createdContainers: ManagedContainer[]) => {
    setContainers((prev) => {
      const existingIds = new Set(prev.map((container) => container.id));
      const newContainers = createdContainers.filter((container) => !existingIds.has(container.id));
      if (newContainers.length === 0) return prev;
      return [...newContainers, ...prev];
    });
    const runningContainers = createdContainers.filter((container) => container.status === "running");
    if (runningContainers.length > 0) {
      void refreshContainerMetadata(runningContainers);
      void refreshInstanceStatuses(runningContainers);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header
        actions={
          <>
            <button
              onClick={() => setDeleteScope("finished")}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-rose-200 rounded-lg text-sm font-medium transition-colors border border-slate-700"
            >
              Delete Finished
            </button>
            <button
              onClick={() => setDeleteScope("all")}
              className="px-3.5 py-2 bg-rose-900/70 hover:bg-rose-800 text-rose-100 rounded-lg text-sm font-medium transition-colors border border-rose-800"
            >
              Delete All
            </button>
            <button
              onClick={() => setShowModal(true)}
              className="px-3.5 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg text-sm font-semibold transition-colors border border-slate-600"
            >
              New Container
            </button>
          </>
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
            getContainerInstanceStatus={(container) => instanceStatusByContainerId[container.id] || null}
            onRefresh={loadContainers}
          />
        )}
      </main>
      {showModal && (
        <NewContainerModal
          onClose={() => setShowModal(false)}
          onCreated={handleContainersCreated}
        />
      )}
      {deleteScope && (
        <ConfirmDeleteModal
          title={deleteScope === "all" ? "Delete All Containers" : "Delete Finished Containers"}
          message={
            deleteScope === "all"
              ? "This will stop and remove all containers. This action cannot be undone."
              : "This will stop and remove every container whose Claude instance has finished. This action cannot be undone."
          }
          confirmLabel={deleteScope === "all" ? "Delete All" : "Delete Finished"}
          onConfirm={deleteScope === "all" ? deleteAllContainers : deleteFinishedContainers}
          onClose={() => setDeleteScope(null)}
          onDeleted={() => {
            setDeleteScope(null);
            void loadContainers();
          }}
        />
      )}
      <Footer />
    </div>
  );
}
