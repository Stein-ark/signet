'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import SignaturePad from 'signature_pad';
import { ArrowLeft, ArrowRight, CheckCircle2, FileCheck2, ShieldCheck } from 'lucide-react';
import type { FieldType, PageGeometry } from '@/lib/models/types';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

type SigningField = {
  id: string;
  page: number;
  type: FieldType;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required: boolean;
  label: string;
  fontSize: number;
  maxLength: number;
  value: string | null;
};
type SigningData = {
  title: string;
  ownerName: string;
  recipient: { id: string; name: string; email: string };
  csrfToken: string;
  consentText: string;
  document: { filename: string; pageCount: number; pages: PageGeometry[] };
  fields: SigningField[];
};

function fieldLabel(field: SigningField): string {
  return field.label || ({
    signature: 'Signature',
    initials: 'Initials',
    date: 'Date',
    text: 'Text',
    checkbox: 'Checkbox',
  } as Record<FieldType, string>)[field.type];
}

export function SigningWorkspace({
  token,
  title,
  ownerName,
  recipientName,
}: {
  token: string;
  title: string;
  ownerName: string;
  recipientName: string;
}) {
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [data, setData] = useState<SigningData | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(760);
  const [adoptedName, setAdoptedName] = useState(recipientName);
  const [consented, setConsented] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [finished, setFinished] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const previewRef = useRef<HTMLDivElement>(null);
  const signatureCanvas = useRef<HTMLCanvasElement>(null);
  const initialsCanvas = useRef<HTMLCanvasElement>(null);
  const signaturePad = useRef<SignaturePad | null>(null);
  const initialsPad = useRef<SignaturePad | null>(null);

  const requestUrl = `/api/sign/${encodeURIComponent(token)}`;
  const pdfUrl = `${requestUrl}/document`;
  const ownFields = data?.fields ?? [];
  const fieldsOnPage = useMemo(() => ownFields.filter((field) => field.page === page), [ownFields, page]);
  const initialsRequired = ownFields.some((field) => field.type === 'initials' && field.required);

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.min(900, Math.max(280, Math.floor(entry.contentRect.width))));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!data || finished) return;
    const pads: SignaturePad[] = [];
    const setup = (canvas: HTMLCanvasElement | null, ref: { current: SignaturePad | null }) => {
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = Math.floor(bounds.width * ratio);
      canvas.height = Math.floor(bounds.height * ratio);
      const context = canvas.getContext('2d');
      context?.scale(ratio, ratio);
      const pad = new SignaturePad(canvas, {
        minWidth: 0.8,
        maxWidth: 2.3,
        penColor: '#213d2b',
        backgroundColor: 'rgba(255,255,255,0)',
      });
      ref.current = pad;
      pads.push(pad);
    };
    setup(signatureCanvas.current, signaturePad);
    if (initialsRequired) setup(initialsCanvas.current, initialsPad);
    return () => {
      pads.forEach((pad) => pad.off());
      signaturePad.current = null;
      initialsPad.current = null;
    };
  }, [data, initialsRequired, finished]);

  const loadSigningSession = useCallback(async () => {
    const response = await fetch(`${requestUrl}/session`, { cache: 'no-store' });
    const result = (await response.json()) as {
      signing?: SigningData;
      error?: { message?: string };
    };
    if (!response.ok || !result.signing) {
      throw new Error(result.error?.message ?? 'Your signing session could not be loaded.');
    }
    setData(result.signing);
    setAdoptedName(result.signing.recipient.name);
    setCodeSent(false);
    setNotice('Your email is verified. Review the document and complete your fields.');
  }, [requestUrl]);

  async function requestCode() {
    setError('');
    setBusy(true);
    try {
      const response = await fetch(`${requestUrl}/otp`, { method: 'POST' });
      const result = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'A verification code could not be sent.');
      setCodeSent(true);
      setNotice(`A verification code was sent to ${recipientName ? 'your email address' : 'the invited email address'}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A verification code could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await fetch(`${requestUrl}/otp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const result = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? 'That verification code could not be checked.');
      await loadSigningSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That verification code could not be checked.');
    } finally {
      setBusy(false);
    }
  }

  function updateField(id: string, value: string) {
    setData((current) => current
      ? {
          ...current,
          fields: current.fields.map((field) => field.id === id ? { ...field, value } : field),
        }
      : current);
  }

  async function saveFieldValues() {
    if (!data) return;
    const editableFields = data.fields.filter(
      (field) => field.type === 'text' || field.type === 'date' || field.type === 'checkbox',
    );
    const response = await fetch(`${requestUrl}/fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-signet-csrf': data.csrfToken },
      body: JSON.stringify({
        fields: editableFields.map((field) => ({
          id: field.id,
          value: field.type === 'checkbox' ? (field.value === 'true' ? 'true' : 'false') : field.value ?? '',
        })),
      }),
    });
    const result = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? 'Your fields could not be saved.');
  }

  async function completeSignature() {
    if (!data) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (!consented) throw new Error('Confirm your electronic-signature consent before signing.');
      if (!adoptedName.trim()) throw new Error('Enter the name you are adopting for this signature.');
      if (!signaturePad.current || signaturePad.current.isEmpty()) {
        throw new Error('Draw your signature before completing the document.');
      }
      if (initialsRequired && (!initialsPad.current || initialsPad.current.isEmpty())) {
        throw new Error('Draw your initials before completing the document.');
      }

      await saveFieldValues();
      const signaturePng = signaturePad.current.toDataURL('image/png').split(',')[1] ?? '';
      const initialsPng =
        initialsPad.current && !initialsPad.current.isEmpty()
          ? initialsPad.current.toDataURL('image/png').split(',')[1]
          : undefined;
      const response = await fetch(`${requestUrl}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signet-csrf': data.csrfToken },
        body: JSON.stringify({
          adoptedName: adoptedName.trim(),
          consent: true,
          signaturePng,
          ...(initialsPng ? { initialsPng } : {}),
        }),
      });
      const result = (await response.json()) as {
        signed?: boolean;
        error?: { message?: string };
      };
      if (!response.ok || !result.signed) {
        throw new Error(result.error?.message ?? 'Your signature could not be completed.');
      }
      setFinished(true);
      setNotice('Your signature has been recorded. You can close this page.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your signature could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  async function declineSigning() {
    if (!data) return;
    setError('');
    setBusy(true);
    try {
      const response = await fetch(`${requestUrl}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signet-csrf': data.csrfToken },
        body: JSON.stringify({ reason: declineReason }),
      });
      const result = (await response.json()) as { declined?: boolean; error?: { message?: string } };
      if (!response.ok || !result.declined) {
        throw new Error(result.error?.message ?? 'Your response could not be recorded.');
      }
      setDeclined(true);
      setFinished(true);
      setNotice('Your decision not to sign has been recorded.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your response could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  if (finished) {
    return (
      <main className="signing-page">
        <header className="signing-header"><Link className="brand" href="/"><span className="signing-brand-mark">s</span><span>signet</span></Link><span>Secure signing</span></header>
        <section className="signing-complete">
          <span><CheckCircle2 size={32} /></span>
          <p className="eyebrow">{declined ? 'RESPONSE RECORDED' : 'SIGNATURE RECORDED'}</p>
          <h1>{declined ? 'Your response has been recorded.' : `Thank you, ${adoptedName}.`}</h1>
          <p>{notice}</p>
          <Link href="/">Return to Signet</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="signing-page">
      <header className="signing-header">
        <Link className="brand" href="/"><span className="signing-brand-mark">s</span><span>signet</span></Link>
        <span className="signing-secure"><ShieldCheck size={15} /> Secure signing session</span>
      </header>
      <div className="signing-content">
        <section className="signing-intro">
          <p className="eyebrow">DOCUMENT FOR YOUR SIGNATURE</p>
          <h1>{title}</h1>
          <p>{ownerName} invited you to review and sign this document.</p>
        </section>

        {!data ? (
          <section className="verification-card">
            <span className="verification-icon"><ShieldCheck size={21} /></span>
            <h2>Verify your email to continue.</h2>
            <p>We will send a one-time code to the email address this invitation was sent to.</p>
            {error && <p className="signing-error" role="alert">{error}</p>}
            {codeSent ? (
              <form className="otp-form" onSubmit={verifyCode}>
                <label htmlFor="otp-code">Six-digit verification code</label>
                <input
                  id="otp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <button className="signing-primary" type="submit" disabled={busy || code.length !== 6}>
                  {busy ? 'Checking code…' : 'Verify email'}
                </button>
                <button className="signing-text-button" type="button" onClick={requestCode} disabled={busy}>
                  Send another code
                </button>
              </form>
            ) : (
              <button className="signing-primary" type="button" onClick={requestCode} disabled={busy}>
                {busy ? 'Sending code…' : 'Send verification code'}
              </button>
            )}
            <p className="verification-privacy"><ShieldCheck size={13} /> Your code can only be used once and expires shortly.</p>
          </section>
        ) : (
          <div className="signing-layout">
            <section className="signing-document">
              <div className="signing-document-bar">
                <span><FileCheck2 size={15} /> {data.document.filename}</span>
                <div className="sign-page-control">
                  <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} aria-label="Previous page"><ArrowLeft size={13} /></button>
                  <span>{page} / {data.document.pageCount}</span>
                  <button type="button" onClick={() => setPage((current) => Math.min(data.document.pageCount, current + 1))} disabled={page >= data.document.pageCount} aria-label="Next page"><ArrowRight size={13} /></button>
                </div>
              </div>
              {pdfError ? (
                <p className="signing-error" role="alert">{pdfError}</p>
              ) : (
                <div className="sign-pdf-area" ref={previewRef}>
                  <Document
                    file={pdfUrl}
                    onLoadError={() => setPdfError('The document preview could not be loaded. Reload and try again.')}
                    onSourceError={() => setPdfError('The document preview could not be loaded. Reload and try again.')}
                    loading={<p className="sign-pdf-loading">Loading your document…</p>}
                  >
                    <div className="sign-pdf-page">
                      <Page pageNumber={page} width={width} renderAnnotationLayer={false} renderTextLayer={false} />
                      <div className="sign-field-overlay">
                        {fieldsOnPage.map((field) => (
                          <div
                            key={field.id}
                            className={`sign-field-marker sign-marker-${field.type}`}
                            style={{
                              left: `${field.nx * 100}%`,
                              top: `${field.ny * 100}%`,
                              width: `${field.nw * 100}%`,
                              height: `${field.nh * 100}%`,
                            }}
                          >
                            <span>{fieldLabel(field)}{field.required ? ' *' : ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Document>
                </div>
              )}
              <p className="signing-document-hint">Review each page and complete all required fields before signing.</p>
            </section>

            <aside className="signing-controls">
              <section className="signing-card">
                <p className="eyebrow">YOUR DETAILS</p>
                <h2>Complete your fields.</h2>
                <div className="signer-field-list">
                  {ownFields.map((field) => (
                    <label className="signer-field" key={field.id}>
                      <span>{fieldLabel(field)}{field.required ? ' *' : ''}<small>Page {field.page}</small></span>
                      {field.type === 'text' ? (
                        <input
                          value={field.value ?? ''}
                          maxLength={field.maxLength}
                          onChange={(event) => updateField(field.id, event.target.value)}
                          placeholder="Type your response"
                        />
                      ) : field.type === 'date' ? (
                        <input
                          type="date"
                          value={field.value?.slice(0, 10) ?? ''}
                          onChange={(event) => updateField(field.id, event.target.value)}
                        />
                      ) : field.type === 'checkbox' ? (
                        <input
                          className="field-checkbox-input"
                          type="checkbox"
                          checked={field.value === 'true'}
                          onChange={(event) => updateField(field.id, String(event.target.checked))}
                        />
                      ) : field.type === 'signature' ? (
                        <span className="signature-field-note">Draw your signature below.</span>
                      ) : (
                        <span className="signature-field-note">Draw your initials below.</span>
                      )}
                    </label>
                  ))}
                </div>
                <label className="adopted-name">
                  Name you are adopting
                  <input value={adoptedName} onChange={(event) => setAdoptedName(event.target.value)} maxLength={100} />
                </label>
              </section>

              <section className="signing-card signature-card">
                <p className="eyebrow">YOUR SIGNATURE</p>
                <h2>Sign in the box.</h2>
                <canvas className="signature-canvas" ref={signatureCanvas} aria-label="Draw your electronic signature" />
                <button className="signing-text-button clear-signature" type="button" onClick={() => signaturePad.current?.clear()}>
                  Clear signature
                </button>
                {initialsRequired && (
                  <>
                    <h3>Initials</h3>
                    <canvas className="signature-canvas initials-canvas" ref={initialsCanvas} aria-label="Draw your initials" />
                    <button className="signing-text-button clear-signature" type="button" onClick={() => initialsPad.current?.clear()}>
                      Clear initials
                    </button>
                  </>
                )}
              </section>

              <section className="consent-card">
                <label>
                  <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
                  <span>{data.consentText}</span>
                </label>
              </section>
              {error && <p className="signing-error" role="alert">{error}</p>}
              {notice && <p className="signing-notice" role="status">{notice}</p>}
              <button className="signing-primary complete-sign-button" type="button" onClick={completeSignature} disabled={busy}>
                {busy ? 'Recording your signature…' : 'Sign and complete'}
              </button>
              <p className="signing-legal-note">Your signature and consent are recorded with the document’s audit trail.</p>
              <section className="decline-area">
                {!showDecline ? (
                  <button className="signing-text-button" type="button" onClick={() => setShowDecline(true)}>
                    I do not want to sign this document
                  </button>
                ) : (
                  <div className="decline-panel">
                    <label htmlFor="decline-reason">Reason for declining</label>
                    <textarea
                      id="decline-reason"
                      value={declineReason}
                      onChange={(event) => setDeclineReason(event.target.value)}
                      maxLength={500}
                      required
                      rows={3}
                    />
                    <p>Your decision and reason will be recorded and shared with the sender.</p>
                    {error && <p className="signing-error" role="alert">{error}</p>}
                    <button className="decline-submit" type="button" onClick={declineSigning} disabled={busy || !declineReason.trim()}>
                      {busy ? 'Recording…' : 'Confirm decline'}
                    </button>
                  </div>
                )}
              </section>
            </aside>
          </div>
        )}
      </div>
      <footer className="signing-footer">
        <Link href="/">Signet</Link>
        <span>Sign only after you have reviewed the document.</span>
      </footer>
    </main>
  );
}
