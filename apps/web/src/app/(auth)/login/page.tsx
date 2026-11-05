'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InputField } from '@/components/ui/field';
import { FormError } from '@/components/ui/states';
import { useLogin } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';
import { safeRedirectPath } from '@/lib/safe-redirect';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const fieldError = (path: string) =>
    login.error instanceof ApiError ? login.error.fieldError(path) : undefined;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate(
      { email, password },
      { onSuccess: () => router.replace(safeRedirectPath(searchParams.get('next'))) },
    );
  }

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted">Welcome back. Pick up where your traces left off.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <InputField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldError('email')}
        />
        <InputField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldError('password')}
        />
        <FormError error={login.error} />
        <Button type="submit" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        New to TraceMind?{' '}
        <Link href="/register" className="font-medium text-foreground hover:text-primary">
          Create an account
        </Link>
      </p>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
