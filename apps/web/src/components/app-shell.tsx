'use client';

import {
  Activity,
  CircleDollarSign,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  OctagonAlert,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { UserDto } from '@tracemind/shared';
import { useLogout } from '@/hooks/queries';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import { useOrganization } from './organization-context';
import { Button } from './ui/button';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Sections appear here as they ship (Traces and Evaluations arrive with Phase 4) rather than as
 * empty placeholders.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/analytics', label: 'Analytics', icon: Activity },
  { href: '/costs', label: 'Costs', icon: CircleDollarSign },
  { href: '/errors', label: 'Errors', icon: OctagonAlert },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function OrganizationSwitcher() {
  const { organizations, current, select } = useOrganization();
  return (
    <label className="block">
      <span className="sr-only">Organization</span>
      <select
        value={current.id}
        onChange={(event) => select(event.target.value)}
        className="h-9 w-full truncate rounded-md border border-border bg-surface-raised px-2.5 text-sm font-medium hover:border-border-strong focus:border-primary focus:outline-none"
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Sidebar({ user, onNavigate }: { user: UserDto; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const logout = useLogout();

  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Logo className="px-1.5 pt-1" />
      <OrganizationSwitcher />
      <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
                active
                  ? 'bg-surface-raised text-foreground'
                  : 'text-muted hover:bg-surface-raised/60 hover:text-foreground',
              )}
            >
              <Icon className={cn('size-4', active && 'text-primary')} aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="flex items-center gap-2.5 border-t border-border pt-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
          {user.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          loading={logout.isPending}
          onClick={() => logout.mutate(undefined, { onSettled: () => router.replace('/login') })}
        >
          {logout.isPending ? null : <LogOut />}
        </Button>
      </div>
    </div>
  );
}

export function AppShell({ user, children }: { user: UserDto; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:block">
        <div className="sticky top-0 h-dvh">
          <Sidebar user={user} />
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface">
            <Sidebar user={user} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X /> : <Menu />}
          </Button>
          <Logo />
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}
