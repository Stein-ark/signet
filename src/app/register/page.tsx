import Image from 'next/image';
import Link from 'next/link';
import { AuthForm } from '@/app/auth-form';
import '../auth.css';

export default function RegisterPage() {
  return (
    <main className="auth-page">
      <header className="auth-header">
        <Link className="brand" href="/">
          <Image src="/logo.png" alt="" width={34} height={28} priority />
          <span>signet</span>
        </Link>
        <Link href="/">Back to home</Link>
      </header>
      <section className="auth-panel" aria-labelledby="register-title">
        <p className="eyebrow">A BETTER WAY TO GET IT SIGNED</p>
        <h1 id="register-title">Create your account.</h1>
        <p className="auth-intro">Set up your Signet account to prepare and track agreements.</p>
        <AuthForm mode="register" />
      </section>
      <footer className="auth-footer">
        <span>Your documents stay yours.</span>
        <Link href="/login">Sign in</Link>
      </footer>
    </main>
  );
}
