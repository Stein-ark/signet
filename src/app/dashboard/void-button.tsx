'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

function csrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('signet_csrf='));
  return entry ? decodeURIComponent(entry.slice('signet_csrf='.length)) : '';
}

export function VoidButton({ envelopeId }: { envelopeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function cancelAgreement(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const token = csrfToken();
      if (!token) throw new Error('Reload the page and try again.');
      const response = await fetch(`/api/envelopes/${envelopeId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signet-csrf': token },
        body: JSON.stringify({ reason }),
      });
      const result = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'The agreement could not be cancelled.');
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The agreement could not be cancelled.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="remind-control">
      <button type="button" className="void-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        Cancel
      </button>
      {open && (
        <form className="void-panel" onSubmit={cancelAgreement}>
          <label htmlFor={`void-reason-${envelopeId}`}>Reason for cancelling</label>
          <input
            id={`void-reason-${envelopeId}`}
            value={reason}
            maxLength={500}
            required
            autoFocus
            onChange={(event) => setReason(event.target.value)}
          />
          <p>Signing links stop working and waiting recipients are emailed. This cannot be undone.</p>
          {error && <p className="void-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy || !reason.trim()}>
            {busy ? 'Cancelling…' : 'Cancel agreement'}
          </button>
        </form>
      )}
    </span>
  );
}
