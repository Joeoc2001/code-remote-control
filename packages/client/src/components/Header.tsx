import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

interface HeaderProps {
  actions?: ReactNode;
}

const NAV_SEGMENTS = [
  { label: "Containers", to: "/", isActive: (pathname: string) => !pathname.startsWith("/tasks") },
  { label: "Tasks", to: "/tasks", isActive: (pathname: string) => pathname.startsWith("/tasks") },
];

export default function Header({ actions }: HeaderProps) {
  const { pathname } = useLocation();

  return (
    <header className="border-b border-slate-800/90 bg-slate-950/80 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Code Remote Control</h1>
            <p className="text-xs text-slate-400 mt-0.5">Manage Claude Code containers on your host</p>
          </div>
          <nav className="flex shrink-0 rounded-lg border border-slate-700 overflow-hidden">
            {NAV_SEGMENTS.map(({ label, to, isActive }) => {
              const active = isActive(pathname);
              return (
                <Link
                  key={to}
                  to={to}
                  aria-current={active ? "page" : undefined}
                  className={`px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
                    active ? "bg-slate-700 text-slate-100" : "bg-slate-900 text-slate-400 hover:bg-slate-800"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-3">{actions}</div>
      </div>
    </header>
  );
}
