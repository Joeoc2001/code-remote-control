interface HeaderProps {
  onNewContainer: () => void;
  onSettings: () => void;
  onDeleteAll: () => void;
}

export default function Header({ onNewContainer, onSettings, onDeleteAll }: HeaderProps) {
  return (
    <header className="border-b border-slate-800/90 bg-slate-950/80 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Code Remote Control</h1>
          <p className="text-xs text-slate-400 mt-0.5">Manage opencode containers on your host</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onDeleteAll}
            className="px-3.5 py-2 bg-rose-900/70 hover:bg-rose-800 text-rose-100 rounded-lg text-sm font-medium transition-colors border border-rose-800"
          >
            Delete All
          </button>
          <button
            onClick={onSettings}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition-colors border border-slate-700"
          >
            Settings
          </button>
          <button
            onClick={onNewContainer}
            className="px-3.5 py-2 bg-emerald-700 hover:bg-emerald-600 text-emerald-50 rounded-lg text-sm font-semibold transition-colors border border-emerald-600"
          >
            New Container
          </button>
        </div>
      </div>
    </header>
  );
}
