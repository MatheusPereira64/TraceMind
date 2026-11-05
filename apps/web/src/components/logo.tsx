export function LogoMark({ className = 'size-6' }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-linear-to-br from-primary to-accent ${className}`}
    >
      {/* A trace: root span with two nested child spans. */}
      <svg viewBox="0 0 24 24" className="size-full" aria-hidden>
        <rect x="6" y="7" width="12" height="2" rx="1" fill="white" />
        <rect x="8.5" y="11" width="7" height="2" rx="1" fill="white" fillOpacity="0.85" />
        <rect x="11" y="15" width="5" height="2" rx="1" fill="white" fillOpacity="0.7" />
      </svg>
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <LogoMark />
        <span className="text-[15px] font-semibold tracking-tight">TraceMind</span>
      </div>
    </div>
  );
}
