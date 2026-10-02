'use client';

import { useState } from 'react';

function csrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('signet_csrf='));
  return entry ? decodeURIComponent(entry.slice('signet_csrf='.length)) : '';
}

export function RemindButton({ envelopeId }: { envelopeId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function sendReminder() {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      const token = csrfToken();
      if (!token) throw new Error('Reload the page and try again.');
      const response = await fetch(`/api/envelopes/${envelopeId}/remind`, {
        method: 'POST',
        headers: { 'x-signet-csrf': token },
      });
      const result = (await response.json()) as {
        reminded?: number;
        deliveryFailures?: string[];
        warning?: string;
        error?: { message?: string };
      };
      if (!response.ok && response.status !== 207) {
        throw new Error(result.error?.message ?? 'Reminder could not be sent.');
      }
      if (result.deliveryFailures?.length) {
        setFailed(true);
        setMessage(`${result.warning ?? 'Some reminders failed'} (${result.deliveryFailures.join(', ')})`);
      } else {
        setMessage(`Reminder sent to ${result.reminded ?? 0} recipient${result.reminded === 1 ? '' : 's'}.`);
      }
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : 'Reminder could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="remind-control">
      <button type="button" onClick={sendReminder} disabled={busy}>
        {busy ? 'Sending…' : 'Remind'}
      </button>
      {message && <span className={failed ? 'remind-result failed' : 'remind-result'} role={failed ? 'alert' : 'status'}>{message}</span>}
    </span>
  );
}
