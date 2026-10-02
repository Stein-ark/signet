import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readOwnerSession } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { UploadForm } from './upload-form';
import './upload.css';

export default async function NewEnvelopePage() {
  const owner = await readOwnerSession();
  if (!owner) redirect('/login');

  return (
    <main className="upload-page">
      <header className="upload-header">
        <Link className="brand" href="/dashboard">
          <Image src="/logo.png" alt="" width={34} height={28} priority />
          <span>signet</span>
        </Link>
        <Link href="/dashboard">Back to dashboard</Link>
      </header>
      <section className="upload-panel">
        <p className="eyebrow">START AN AGREEMENT</p>
        <h1>Bring your document.</h1>
        <p className="upload-intro">
          Give it a title and upload the PDF you would like people to sign.
        </p>
        <UploadForm maxUploadBytes={env().MAX_UPLOAD_BYTES} />
      </section>
    </main>
  );
}
