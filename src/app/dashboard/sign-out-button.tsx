'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

function csrfToken(): string {
  const value = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith('signet_csrf='));
  return value ? decodeURIComponent(value.slice('signet_csrf='.length)) : '';
}

export function SignOutButton() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setError('');
    setBusy(true);
    try {
      const token = csrfToken();
      if (!token) throw new Error('The security token is missing. Reload the page and try again.');
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-signet-csrf': token },
      });
      if (!response.ok) throw new Error('Sign out did not complete. Please try again.');
      router.replace('/');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign out did not complete. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sign-out">
      {error && <span role="alert">{error}</span>}
      <button type="button" onClick={signOut} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
