import { Link } from "react-router-dom";

export default function QuickPromptBadge({ quickPromptId }: { quickPromptId: string }) {
  return (
    <Link
      to={`/quick-prompts#${encodeURIComponent(quickPromptId)}`}
      onClick={(event) => event.stopPropagation()}
      title="Launched from a quick-prompt"
      className="inline-flex items-center rounded-full border border-indigo-500/50 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-200 hover:border-indigo-400 transition-colors"
    >
      Quick-prompt
    </Link>
  );
}
