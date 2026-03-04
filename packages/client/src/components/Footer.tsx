import { useState, useEffect } from "react";
import { fetchBuildInfo } from "../api";

export default function Footer() {
  const [buildId, setBuildId] = useState<string>("");

  useEffect(() => {
    fetchBuildInfo()
      .then((info) => setBuildId(info.buildId))
      .catch(() => setBuildId("unknown"));
  }, []);

  if (!buildId || buildId === "unknown") return null;

  const shortId = buildId.length > 7 ? buildId.substring(0, 7) : buildId;

  return (
    <footer className="fixed bottom-0 left-0 right-0 bg-gray-900/80 backdrop-blur-sm border-t border-gray-800 px-4 py-2 text-center">
      <p className="text-xs text-gray-500">
        Build: <span className="text-gray-400 font-mono">{shortId}</span>
      </p>
    </footer>
  );
}
