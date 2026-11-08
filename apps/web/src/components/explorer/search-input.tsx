'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Search box that commits after a short pause (or Enter), so typing doesn't fire a query per key. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string | undefined) => void;
  placeholder: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft.trim() === value) return;
    const timer = setTimeout(() => onChange(draft.trim() || undefined), 350);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-sm">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
        aria-hidden
      />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onChange(draft.trim() || undefined);
        }}
        className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-8 text-sm text-foreground placeholder:text-subtle hover:border-border-strong focus:border-primary focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {draft ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-subtle hover:text-foreground"
          onClick={() => {
            setDraft('');
            onChange(undefined);
          }}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Small segmented radio group used for status / view filters. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T | undefined; label: string }>;
  value: T | undefined;
  onChange: (value: T | undefined) => void;
  label: string;
}) {
  return (
    <div
      className="flex rounded-md border border-border p-0.5"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={
            value === option.value
              ? 'h-7 rounded bg-surface-raised px-2.5 text-xs font-medium text-foreground'
              : 'h-7 rounded px-2.5 text-xs font-medium text-muted hover:text-foreground'
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
