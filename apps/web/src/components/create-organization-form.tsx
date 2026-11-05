'use client';

import { useState, type FormEvent } from 'react';
import type { OrganizationDto } from '@tracemind/shared';
import { useCreateOrganization } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';
import { Button } from './ui/button';
import { InputField } from './ui/field';
import { FormError } from './ui/states';

export function CreateOrganizationForm({
  onCreated,
}: {
  onCreated?: (organization: OrganizationDto) => void;
}) {
  const create = useCreateOrganization();
  const [name, setName] = useState('');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      { name },
      {
        onSuccess: (organization) => {
          setName('');
          onCreated?.(organization);
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <InputField
        label="Organization name"
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={create.error instanceof ApiError ? create.error.fieldError('name') : undefined}
      />
      <FormError error={create.error} />
      <Button type="submit" loading={create.isPending}>
        Create organization
      </Button>
    </form>
  );
}
