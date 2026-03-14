import { useParams, Link } from "react-router-dom";
import { useState, useEffect } from "react";
import type { ManagedContainer } from "../types";
import { fetchIframeDomain } from "../api";

const BASE = "/api";

export default function ContainerView() {
  const { id } = useParams<{ id: string }>();
  const [container, setContainer] = useState<ManagedContainer | null>(null);
  const [rootDomain, setRootDomain] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [res, domain] = await Promise.all([
          fetch(`${BASE}/containers/${id}`),
          fetchIframeDomain(),
        ]);
        if (!res.ok) throw new Error("Failed to fetch container");
        const data = await res.json();
        setContainer(data);
        setRootDomain(domain);
        setError(null);
      } catch (err) {
        console.error("Failed to load container:", err);
        setError("Failed to load container");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      <header className="shrink-0 border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          <Link
            to="/"
            className="text-gray-400 hover:text-white transition-colors"
          >
            ← Back
          </Link>
          <h1 className="text-xl font-semibold">Container View</h1>
        </div>
      </header>
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
        </div>
      ) : error || !container ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-red-400 text-lg">{error || "Container not found"}</p>
        </div>
      ) : (
        <iframe
          src={`https://${container.subdomain}.${rootDomain}/`}
          className="flex-1 w-full border-none"
          title="Container Web View"
        />
      )}
    </div>
  );
}
