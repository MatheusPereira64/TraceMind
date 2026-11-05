'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InputField } from '@/components/ui/field';
import { FormError } from '@/components/ui/states';
import { useRegister } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';

export default function RegisterPage() {
  const router = useRouter();
  const register = useRegister();
  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' });

  const fieldError = (path: string) =>
    register.error instanceof ApiError ? register.error.fieldError(path) : undefined;
  const update = (field: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    register.mutate(form, { onSuccess: () => router.replace('/overview') });
  }

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">Create your account</h1>
      <p className="mt-1 text-sm text-muted">Start tracing tokens, costs and latency in minutes.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <InputField
          label="Name"
          autoComplete="name"
          required
          value={form.name}
          onChange={update('name')}
          error={fieldError('name')}
        />
        <InputField
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={update('email')}
          error={fieldError('email')}
        />
        <InputField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={form.password}
          onChange={update('password')}
          hint="At least 10 characters."
          error={fieldError('password')}
        />
        <InputField
          label="Organization"
          autoComplete="organization"
          required
          value={form.organizationName}
          onChange={update('organizationName')}
          hint="Your team's workspace. You can create more later."
          error={fieldError('organizationName')}
        />
        <FormError error={register.error} />
        <Button type="submit" className="w-full" loading={register.isPending}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-foreground hover:text-primary">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
