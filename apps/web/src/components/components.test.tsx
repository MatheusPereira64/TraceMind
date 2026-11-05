import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiKeyDto } from '@tracemind/shared';
import { keyStatus } from './api-keys-panel';
import { Button } from './ui/button';
import { InputField } from './ui/field';
import { ErrorState } from './ui/states';
import { ApiError } from '@/lib/api-client';

const baseKey: ApiKeyDto = {
  id: 'k1',
  projectId: 'p1',
  name: 'ci',
  prefix: 'tm_dev_abcdefgh',
  environment: 'development',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};

describe('keyStatus', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  it('derives active, revoked and expired', () => {
    expect(keyStatus(baseKey, now)).toBe('active');
    expect(keyStatus({ ...baseKey, revokedAt: '2026-02-01T00:00:00Z' }, now)).toBe('revoked');
    expect(keyStatus({ ...baseKey, expiresAt: '2026-05-01T00:00:00Z' }, now)).toBe('expired');
    expect(keyStatus({ ...baseKey, expiresAt: '2026-07-01T00:00:00Z' }, now)).toBe('active');
  });
});

describe('Button', () => {
  it('is disabled and busy while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('InputField', () => {
  it('associates label and error message with the input', () => {
    render(<InputField label="Email" error="Invalid email" defaultValue="x" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Invalid email');
  });
});

describe('ErrorState', () => {
  it('shows the message, request id and a retry action', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        error={new ApiError(500, { message: 'Boom', requestId: 'req-1' })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    expect(screen.getByText('request req-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
