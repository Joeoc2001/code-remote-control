import { useState, useEffect, useCallback } from "react";
import type { ManagedContainer } from "../types";
import { fetchContainers, subscribeToEvents } from "../api";
import Header from "../components/Header";
import ContainerGrid from "../components/ContainerGrid";
import NewContainerModal from "../components/NewContainerModal";
import SettingsModal from "../components/SettingsModal";
import DeleteAllModal from "../components/DeleteAllModal";
import Footer from "../components/Footer";

export default function Home() {
  const [containers, setContainers] = useState<ManagedContainer[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  const loadContainers = useCallback(async () => {
    try {
      const data = await fetchContainers();
      setContainers(data);
      setError(null);
    } catch (err) {
      console.error("Failed to load containers:", err);
      setError("Failed to load containers");
    } finally {
      setLoading(false);
    }
  }, []);

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
      },
      (removedId) => {
        setContainers((prev) => prev.filter((c) => c.id !== removedId));
      },
      loadContainers,
      setConnected,
    );
    return unsubscribe;
  }, [loadContainers]);

  const handleContainerCreated = (container: ManagedContainer) => {
    setContainers((prev) => {
      if (prev.some((c) => c.id === container.id)) return prev;
      return [container, ...prev];
    });
    setShowModal(false);
  };

  return (
    <div className="min-h-screen bg-gray-950">
      <Header
        onNewContainer={() => setShowModal(true)}
        onSettings={() => setShowSettings(true)}
        onDeleteAll={() => setShowDeleteAllModal(true)}
      />
      {!connected && (
        <div className="bg-yellow-900/50 border-b border-yellow-700 px-4 py-2 text-center text-yellow-300 text-sm">
          Connection lost — reconnecting...
        </div>
      )}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <p className="text-red-400 text-lg">{error}</p>
            <button
              onClick={loadContainers}
              className="mt-4 px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : containers.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <p className="text-lg">No containers running</p>
            <p className="mt-2">
              Click "New Container" to spawn a development environment.
            </p>
          </div>
        ) : (
          <ContainerGrid containers={containers} onRefresh={loadContainers} />
        )}
      </main>
      {showModal && (
        <NewContainerModal
          onClose={() => setShowModal(false)}
          onCreated={handleContainerCreated}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
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
