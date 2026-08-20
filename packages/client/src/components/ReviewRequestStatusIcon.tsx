function normalizeReviewRequestState(state: string): "open" | "closed" | "merged" {
  const normalized = state.trim().toLowerCase();

  if (normalized.includes("merge")) {
    return "merged";
  }

  if (normalized.includes("close")) {
    return "closed";
  }

  return "open";
}

export default function ReviewRequestStatusIcon({ state }: { state: string }) {
  const normalizedState = normalizeReviewRequestState(state);

  if (normalizedState === "merged") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <path d="M5.2 8.2 7.2 10l3.6-3.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (normalizedState === "closed") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-rose-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <path d="M5.5 5.5 10.5 10.5" strokeLinecap="round" />
        <path d="M10.5 5.5 5.5 10.5" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-sky-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}
