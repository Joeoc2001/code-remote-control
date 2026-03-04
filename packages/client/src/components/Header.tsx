interface HeaderProps {
  onNewContainer: () => void;
  onSettings: () => void;
  onDeleteAll: () => void;
}

export default function Header({ onNewContainer, onSettings, onDeleteAll }: HeaderProps) {
  return (
    <header className="border-b border-gray-800 bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Code Remote Control</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={onDeleteAll}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Delete All
          </button>
          <button
            onClick={onSettings}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Settings
          </button>
          <button
            onClick={onNewContainer}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            New Container
          </button>
        </div>
      </div>
    </header>
  );
}
