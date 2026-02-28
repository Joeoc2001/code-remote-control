import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";

export default function ContainerLogs() {
  const { id } = useParams<{ id: string }>();
  const [logs, setLogs] = useState<string[]>([]);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!id) return;

    const eventSource = new EventSource(`/api/containers/${id}/logs`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      setError(null);
    };

    eventSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.log) {
          setLogs((prev) => [...prev, data.log]);
        }
      } catch (err) {
        console.error("Failed to parse log message:", err);
      }
    });

    eventSource.addEventListener("end", () => {
      eventSource.close();
      setConnected(false);
    });

    eventSource.onerror = () => {
      setConnected(false);
      setError("Failed to connect to log stream");
    };

    return () => {
      eventSource.close();
    };
  }, [id]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center gap-4">
          <Link
            to="/"
            className="text-gray-400 hover:text-white transition-colors"
          >
            ← Back
          </Link>
          <h1 className="text-xl font-semibold">Container Logs</h1>
          {!connected && (
            <span className="ml-auto text-sm text-yellow-400">
              {error || "Disconnected"}
            </span>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 font-mono text-sm overflow-auto">
          {logs.length === 0 ? (
            <div className="text-gray-500 text-center py-8">
              {connected ? "Waiting for logs..." : "No logs available"}
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((log, idx) => (
                <div key={idx} className="text-gray-300 whitespace-pre-wrap break-all">
                  {log}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
