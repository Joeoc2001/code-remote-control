import { useParams, Link } from "react-router-dom";

export default function ContainerView() {
  const { id } = useParams<{ id: string }>();

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
      <iframe
        src={`/proxy/${id}/`}
        className="flex-1 w-full border-none"
        title="Container Web View"
      />
    </div>
  );
}
