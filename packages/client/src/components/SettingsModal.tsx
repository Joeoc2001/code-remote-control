import { useState, useEffect, useCallback } from "react";
import { updateAndRestart } from "../api";

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !updating) onClose();
    },
    [onClose, updating],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleUpdateAndRestart = async () => {
    setUpdating(true);
    setError(null);
    setSuccess(false);
    try {
      await updateAndRestart();
      setSuccess(true);
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err) {
      setError("Failed to update and restart: " + String(err));
      setUpdating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !updating) onClose();
      }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            disabled={updating}
            className="text-gray-400 hover:text-white text-xl leading-none disabled:opacity-50"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">System Update</h3>
            <p className="text-sm text-gray-400 mb-4">
              Pull the latest version of Code Remote Control and restart the server.
            </p>
            <button
              onClick={handleUpdateAndRestart}
              disabled={updating || success}
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {updating ? "Updating..." : success ? "Update Complete" : "Update and Restart"}
            </button>
          </div>

          {error && (
            <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg p-3">
              {error}
            </div>
          )}

          {success && (
            <div className="text-green-400 text-sm bg-green-900/20 border border-green-800 rounded-lg p-3">
              Update initiated successfully. The server will restart shortly.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-gray-800">
          <button
            onClick={onClose}
            disabled={updating}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
