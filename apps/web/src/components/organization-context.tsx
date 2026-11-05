'use client';

import type { OrganizationDto } from '@tracemind/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'tracemind:organizationId';

interface OrganizationContextValue {
  organizations: OrganizationDto[];
  current: OrganizationDto;
  select: (organizationId: string) => void;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Tracks the organization the user is working in; remembered per browser as a convenience. */
export function OrganizationProvider({
  organizations,
  children,
}: {
  organizations: OrganizationDto[];
  children: ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readStoredId(),
  );

  const current = organizations.find((org) => org.id === selectedId) ?? organizations[0];

  const select = useCallback((organizationId: string) => {
    setSelectedId(organizationId);
    try {
      window.localStorage.setItem(STORAGE_KEY, organizationId);
    } catch {
      // Storage may be unavailable (private mode); selection still works for this session.
    }
  }, []);

  const value = useMemo(
    () => (current ? { organizations, current, select } : null),
    [organizations, current, select],
  );

  if (!value) return null;
  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganization(): OrganizationContextValue {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error('useOrganization must be used inside OrganizationProvider');
  return value;
}
