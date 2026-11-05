'use client';

import type { ProjectDto } from '@tracemind/shared';
import { useState, type FormEvent } from 'react';
import { useCreateProject } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { InputField, TextareaField } from './ui/field';
import { FormError } from './ui/states';

export function CreateProjectDialog({
  organizationId,
  open,
  onClose,
  onCreated,
}: {
  organizationId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectDto) => void;
}) {
  const create = useCreateProject(organizationId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const fieldError = (path: string) =>
    create.error instanceof ApiError ? create.error.fieldError(path) : undefined;

  function close() {
    setName('');
    setDescription('');
    create.reset();
    onClose();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      { name, ...(description.trim() ? { description } : {}) },
      {
        onSuccess: (project) => {
          close();
          onCreated(project);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New project"
      description="A project groups the telemetry of one application."
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <InputField
          label="Name"
          placeholder="Customer support assistant"
          required
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError('name')}
        />
        <TextareaField
          label="Description"
          placeholder="Optional"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={fieldError('description')}
        />
        <FormError error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
