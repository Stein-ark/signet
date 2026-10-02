'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type AuthFormProps = {
  mode: 'login' | 'register';
};

type ApiError = {
  error?: {
    message?: string;
    details?: Record<string, string>;
  };
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setFieldErrors({});
    setBusy(true);

    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ApiError;

      if (!response.ok) {
        const details = result.error?.details;
        if (details && typeof details === 'object') setFieldErrors(details);
        setError(result.error?.message ?? 'We could not complete that request. Try again.');
        return;
      }

      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('We could not reach Signet. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" method="post" onSubmit={submit}>
      {isRegister && (
        <label>
          Your name
          <input
            autoComplete="name"
            name="name"
            required
            maxLength={100}
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? 'name-error' : undefined}
          />
          {fieldErrors.name && <span className="field-error" id="name-error">{fieldErrors.name}</span>}
        </label>
      )}
      <label>
        Email address
        <input
          autoComplete="email"
          name="email"
          type="email"
          required
          maxLength={254}
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? 'email-error' : undefined}
        />
        {fieldErrors.email && <span className="field-error" id="email-error">{fieldErrors.email}</span>}
      </label>
      <label>
        Password
        <input
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          name="password"
          type="password"
          required
          minLength={isRegister ? 12 : 1}
          maxLength={128}
          aria-invalid={Boolean(fieldErrors.password)}
          aria-describedby={fieldErrors.password ? 'password-error' : isRegister ? 'password-hint' : undefined}
        />
        {fieldErrors.password ? (
          <span className="field-error" id="password-error">{fieldErrors.password}</span>
        ) : isRegister ? (
          <span className="field-hint" id="password-hint">Use at least 12 characters.</span>
        ) : null}
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="auth-submit" type="submit" disabled={busy}>
        {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
      </button>
      <p className="auth-switch">
        {isRegister ? 'Already have an account?' : 'New to Signet?'}{' '}
        <Link href={isRegister ? '/login' : '/register'}>
          {isRegister ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </form>
  );
}
