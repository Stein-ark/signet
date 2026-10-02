'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

function csrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('signet_csrf='));
  return entry ? decodeURIComponent(entry.slice('signet_csrf='.length)) : '';
}

export function UploadForm({ maxUploadBytes }: { maxUploadBytes: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = event.currentTarget;
    const file = new FormData(form).get('file');
    if (!(file instanceof File) || !file.size) {
      setError('Choose a PDF to continue.');
      return;
    }
    if (file.size > maxUploadBytes) {
      setError(`Choose a PDF smaller than ${Math.floor(maxUploadBytes / (1024 * 1024))} MB.`);
      return;
    }

    const csrf = csrfToken();
    if (!csrf) {
      setError('Your security token is missing. Reload this page and try again.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/envelopes', {
        method: 'POST',
        headers: { 'x-signet-csrf': csrf },
        body: new FormData(form),
      });
      const result = (await response.json()) as {
        envelope?: { id: string };
        error?: { message?: string };
      };
      if (!response.ok || !result.envelope) {
        setError(result.error?.message ?? 'The document could not be uploaded. Try again.');
        return;
      }
      router.push(`/dashboard/envelopes/${result.envelope.id}/prepare`);
    } catch {
      setError('We could not reach Signet. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="upload-form" onSubmit={submit}>
      <label>
        Agreement title
        <input name="title" required maxLength={160} placeholder="e.g. Consulting agreement" />
      </label>
      <label className="upload-drop">
        <span className="upload-icon">↑</span>
        <strong>Choose a PDF to upload</strong>
        <span>PDF only · up to {Math.floor(maxUploadBytes / (1024 * 1024))} MB</span>
        <input name="file" type="file" accept="application/pdf,.pdf" required />
      </label>
      {error && <p className="upload-error" role="alert">{error}</p>}
      <button className="upload-submit" type="submit" disabled={busy}>
        {busy ? 'Uploading securely…' : 'Upload and prepare'}
      </button>
      <p className="upload-privacy">Your PDF is encrypted before it is stored.</p>
    </form>
  );
}
