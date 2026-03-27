import { useState, useEffect, useCallback } from "react";
import { deleteAllContainers } from "../api";

interface DeleteAllModalProps {
  onClose: () => void;
  onDeleted: () => void;
}

export default function DeleteAllModal({ onClose, onDeleted }: DeleteAllModalProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) onClose();
    },
    [onClose, deleting],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAllContainers();
      onDeleted();
    } catch (err) {
      setError("Failed to delete containers: " + String(err));
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !deleting) onClose();
      }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-slate-100">Delete All Containers</h2>
          <button
            onClick={onClose}
            disabled={deleting}
            className="text-slate-400 hover:text-slate-100 text-xl leading-none disabled:opacity-50"
          >
            &times;
          </button>
        </div>

        <div className="p-5">
          <p className="text-slate-300 text-sm">
            This will stop and remove all containers. This action cannot be undone.
          </p>
          {error && (
            <div className="mt-4 text-rose-300 text-sm bg-rose-900/20 border border-rose-800 rounded-lg p-3">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-slate-800">
          <button
            onClick={onClose}
            disabled={deleting}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={deleting}
            className="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-rose-50 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deleting ? "Deleting..." : "Delete All"}
          </button>
        </div>
      </div>
    </div>
  );
}
