import { useState } from "react";
import type { RepoSource } from "../types";

export type RepoEntry = {
  fullName: string;
  description: string | null;
  source: RepoSource;
};

interface RepoPickerProps {
  repos: RepoEntry[];
  gitlabConfigured: boolean;
  selectedRepo: RepoEntry | null;
  onSelect: (repo: RepoEntry) => void;
}

export default function RepoPicker({ repos, gitlabConfigured, selectedRepo, onSelect }: RepoPickerProps) {
  const [repoSearch, setRepoSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | RepoSource>("all");

  const filteredRepos = repos.filter((r) => {
    const matchesSearch = r.fullName.toLowerCase().includes(repoSearch.toLowerCase());
    const matchesSource = sourceFilter === "all" || r.source === sourceFilter;
    return matchesSearch && matchesSource;
  });

  return (
    <div>
      <label className="block text-sm font-medium text-slate-300 mb-1">
        Repository
      </label>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="Search repositories..."
          value={repoSearch}
          onChange={(e) => setRepoSearch(e.target.value)}
          className="flex-1 bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm"
        />
        {gitlabConfigured && (
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as "all" | RepoSource)}
            className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm"
          >
            <option value="all">All</option>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        )}
      </div>
      <div className="max-h-48 overflow-y-auto border border-slate-700 rounded-lg">
        {filteredRepos.length === 0 ? (
          <div className="p-3 text-sm text-slate-500">
            No repositories found
          </div>
        ) : (
          filteredRepos.map((repo) => (
            <button
              key={`${repo.source}:${repo.fullName}`}
              onClick={() => onSelect(repo)}
              className={`w-full text-left px-3 py-2 text-sm border-b border-slate-800 last:border-0 transition-colors ${selectedRepo?.source === repo.source && selectedRepo?.fullName === repo.fullName
                ? "bg-slate-700/40 text-slate-100"
                : "text-slate-300 hover:bg-slate-800"
                }`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${repo.source === "gitlab"
                    ? "bg-orange-900/40 text-orange-300"
                    : "bg-slate-700 text-slate-300"
                   }`}>
                  {repo.source === "gitlab" ? "GL" : "GH"}
                </span>
                <span className="font-medium">{repo.fullName}</span>
              </div>
              {repo.description && (
                <div className="text-xs text-slate-500 mt-0.5 truncate ml-8">
                  {repo.description}
                </div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
