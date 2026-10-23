import ReviewRequestStatusIcon from "./ReviewRequestStatusIcon";

export default function ReviewRequestBadge({ url, id, state }: { url: string; id: string; state: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={`PR/MR #${id} (${state})`}
      aria-label={`Open PR/MR #${id} (${state})`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-700/80 bg-slate-800/60 px-2 py-1 text-xs text-slate-200 hover:border-slate-500 hover:text-white transition-colors"
    >
      <ReviewRequestStatusIcon state={state} />
      <span className="truncate">PR/MR #{id}</span>
    </a>
  );
}
