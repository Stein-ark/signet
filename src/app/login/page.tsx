import Image from 'next/image';
import Link from 'next/link';
import { AuthForm } from '@/app/auth-form';
import '../auth.css';

export default function LoginPage() {
  return (
    <main className="auth-page">
      <header className="auth-header">
        <Link className="brand" href="/">
          <Image src="/logo.png" alt="" width={34} height={28} priority />
          <span>signet</span>
        </Link>
        <Link href="/">Back to home</Link>
      </header>
      <section className="auth-panel" aria-labelledby="login-title">
        <p className="eyebrow">WELCOME BACK</p>
        <h1 id="login-title">Sign in to Signet.</h1>
        <p className="auth-intro">Pick up where you left off and keep your agreements moving.</p>
        <AuthForm mode="login" />
      </section>
      <footer className="auth-footer">
        <span>Careful signing for documents that matter.</span>
        <Link href="/register">Create an account</Link>
      </footer>
    </main>
  );
}
