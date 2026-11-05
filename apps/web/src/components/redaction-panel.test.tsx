import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_REDACTION_SETTINGS } from '@tracemind/shared';
import { RedactionPanel } from './redaction-panel';

function renderPanel(canEdit = true) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RedactionPanel projectId="p1" settings={DEFAULT_REDACTION_SETTINGS} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

describe('RedactionPanel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends trimmed custom terms and toggles, and confirms the save', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json({
        id: 'p1',
        organizationId: 'o1',
        redaction: JSON.parse(String(init?.body)).redaction,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();

    const save = screen.getByRole('button', { name: 'Save redaction settings' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByLabelText(/Mask phone numbers/));
    await userEvent.type(
      screen.getByLabelText('Custom terms'),
      '  acme.internal  {Enter}{Enter}Projeto X',
    );
    expect(save).toBeEnabled();
    await userEvent.click(save);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/p1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toEqual({
      redaction: {
        enabled: true,
        maskEmails: true,
        maskPhoneNumbers: true,
        literals: ['acme.internal', 'Projeto X'],
      },
    });
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
  });

  it('disables dependent toggles when masking is off and is read-only for viewers', async () => {
    renderPanel();
    await userEvent.click(screen.getByLabelText(/Mask secrets/));
    expect(screen.getByLabelText(/Mask email addresses/)).toBeDisabled();

    renderPanel(false);
    expect(screen.getAllByLabelText(/Mask secrets/)[1]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Save redaction settings' })).toHaveLength(1);
  });
});
