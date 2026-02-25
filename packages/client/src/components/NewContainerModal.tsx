import { useState, useEffect } from "react";
import type { EnvironmentConfig, GitHubRepo, ManagedContainer } from "../types";
import { fetchConfigs, fetchGitHubRepos, createContainer } from "../api";

interface NewContainerModalProps {
  onClose: () => void;
  onCreated: (container: ManagedContainer) => void;
}

export default function NewContainerModal({
  onClose,
  onCreated,
}: NewContainerModalProps) {
  const [configs, setConfigs] = useState<EnvironmentConfig[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedConfig, setSelectedConfig] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchConfigs(), fetchGitHubRepos()])
      .then(([configData, repoData]) => {
        setConfigs(configData);
        setRepos(repoData);
        if (configData.length > 0) setSelectedConfig(configData[0].name);
      })
      .catch((err) => {
        setError("Failed to load data: " + String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  const filteredRepos = repos.filter((r) =>
    r.fullName.toLowerCase().includes(repoSearch.toLowerCase())
  );

  const handleSpawn = async () => {
    if (!selectedConfig || !selectedRepo) return;
    setSpawning(true);
    setError(null);
    try {
      const container = await createContainer(selectedConfig, selectedRepo);
      onCreated(container);
    } catch (err) {
      setError("Failed to spawn container: " + String(err));
    } finally {
      setSpawning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">New Container</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full" />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Configuration
                </label>
                <select
                  value={selectedConfig}
                  onChange={(e) => setSelectedConfig(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm"
                >
                  {configs.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} — {c.description}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Repository
                </label>
                <input
                  type="text"
                  placeholder="Search repositories..."
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm mb-2"
                />
                <div className="max-h-48 overflow-y-auto border border-gray-700 rounded-lg">
                  {filteredRepos.length === 0 ? (
                    <div className="p-3 text-sm text-gray-500">
                      No repositories found
                    </div>
                  ) : (
                    filteredRepos.map((repo) => (
                      <button
                        key={repo.fullName}
                        onClick={() => setSelectedRepo(repo.fullName)}
                        className={`w-full text-left px-3 py-2 text-sm border-b border-gray-800 last:border-0 transition-colors ${
                          selectedRepo === repo.fullName
                            ? "bg-blue-600/20 text-blue-300"
                            : "text-gray-300 hover:bg-gray-800"
                        }`}
                      >
                        <div className="font-medium">{repo.fullName}</div>
                        {repo.description && (
                          <div className="text-xs text-gray-500 mt-0.5 truncate">
                            {repo.description}
                          </div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>

              {error && (
                <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg p-3">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-gray-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSpawn}
            disabled={!selectedConfig || !selectedRepo || spawning || loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {spawning ? "Spawning..." : "Spawn"}
          </button>
        </div>
      </div>
    </div>
  );
}
