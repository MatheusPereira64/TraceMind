import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SpanDto } from '@tracemind/shared';
import { PayloadView, StatusBadge } from './primitives';
import { Waterfall } from './waterfall';

const base: SpanDto = {
  uid: 'u1',
  id: 'agent',
  parentId: null,
  name: 'support-agent',
  kind: 'chain',
  status: 'success',
  provider: null,
  model: null,
  input: null,
  output: null,
  modelParameters: null,
  metadata: {},
  startedAt: '2026-11-01T12:00:00.000Z',
  endedAt: '2026-11-01T12:00:02.000Z',
  durationMs: 2_000,
  usage: null,
  errors: [],
};

describe('PayloadView', () => {
  it('renders chat messages by role and can switch to raw JSON', async () => {
    const messages = [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Where is my order?' },
    ];
    render(<PayloadView value={messages} />);
    expect(screen.getByText('Where is my order?')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
    expect(screen.getByText(/"role": "user"/)).toBeInTheDocument();
  });

  it('shows a placeholder for missing payloads and JSON for other values', () => {
    const { rerender } = render(<PayloadView value={null} empty="No output" />);
    expect(screen.getByText('No output')).toBeInTheDocument();
    rerender(<PayloadView value={{ orderId: 42 }} />);
    expect(screen.getByText(/"orderId": 42/)).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('pairs the status color with a word', () => {
    render(<StatusBadge status="error" />);
    expect(screen.getByText('Error')).toBeInTheDocument();
  });
});

describe('Waterfall', () => {
  it('lists spans in tree order and reports the selected span', async () => {
    const spans: SpanDto[] = [
      base,
      {
        ...base,
        uid: 'u2',
        id: 'answer',
        parentId: 'agent',
        name: 'generate-answer',
        kind: 'llm',
        status: 'error',
        startedAt: '2026-11-01T12:00:00.500Z',
        endedAt: '2026-11-01T12:00:01.500Z',
        durationMs: 1_000,
      },
    ];
    const onSelect = vi.fn();
    render(
      <Waterfall
        spans={spans}
        trace={{ startedAt: base.startedAt, endedAt: base.endedAt }}
        selectedId="agent"
        onSelect={onSelect}
      />,
    );
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveTextContent('support-agent');
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).toHaveTextContent('generate-answer');
    expect(screen.getByLabelText('Error')).toBeInTheDocument();

    await userEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledWith('answer');
  });
});
