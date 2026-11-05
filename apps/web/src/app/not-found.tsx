import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-mono text-sm text-primary">404</p>
      <h1 className="text-xl font-semibold">This page doesn&apos;t exist</h1>
      <Link
        href="/overview"
        className={buttonVariants({ variant: 'secondary', className: 'mt-2' })}
      >
        Back to overview
      </Link>
    </main>
  );
}
