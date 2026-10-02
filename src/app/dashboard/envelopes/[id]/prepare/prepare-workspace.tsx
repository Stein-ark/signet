'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, FileText, Plus, Trash2 } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { FieldType } from '@/lib/models/types';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

type Recipient = { id: string; name: string; email: string; routingOrder: number };
type PlacedField = {
  id: string;
  recipientId: string;
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
};
type DraftData = {
  id: string;
  title: string;
  status: string;
  recipients: Recipient[];
  fields: PlacedField[];
  document: { filename: string; pageCount: number };
};

const fieldLabels: Record<FieldType, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date',
  text: 'Text',
  checkbox: 'Checkbox',
};

const fieldSizes: Record<FieldType, { nw: number; nh: number }> = {
  signature: { nw: 0.25, nh: 0.07 },
  initials: { nw: 0.15, nh: 0.07 },
  date: { nw: 0.2, nh: 0.055 },
  text: { nw: 0.28, nh: 0.07 },
  checkbox: { nw: 0.055, nh: 0.055 },
};

function csrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('signet_csrf='));
  return entry ? decodeURIComponent(entry.slice('signet_csrf='.length)) : '';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function PrepareWorkspace({ initial }: { initial: DraftData }) {
  const router = useRouter();
  const [recipients, setRecipients] = useState(initial.recipients);
  const [fields, setFields] = useState(initial.fields);
  const [activeType, setActiveType] = useState<FieldType | null>(null);
  const [activeRecipient, setActiveRecipient] = useState(initial.recipients[0]?.id ?? '');
  const [pageNumber, setPageNumber] = useState(1);
  const [renderWidth, setRenderWidth] = useState(700);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pdfError, setPdfError] = useState('');
  const viewerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const pdfUrl = `/api/envelopes/${initial.id}/document`;

  useEffect(() => {
    const element = viewerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRenderWidth(Math.min(850, Math.max(280, Math.floor(entry.contentRect.width))));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fieldsOnPage = useMemo(
    () => fields.filter((field) => field.page === pageNumber),
    [fields, pageNumber],
  );

  async function saveRecipients() {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const token = csrfToken();
      if (!token) throw new Error('Your security token is missing. Reload this page and try again.');
      const response = await fetch(`/api/envelopes/${initial.id}/recipients`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-signet-csrf': token },
        body: JSON.stringify({
          recipients: recipients.map(({ name, email }) => ({ name, email })),
        }),
      });
      const result = (await response.json()) as { recipients?: Recipient[]; error?: { message?: string } };
      if (!response.ok || !result.recipients) {
        throw new Error(result.error?.message ?? 'Recipients could not be saved.');
      }
      setRecipients(result.recipients);
      setFields((current) =>
        current.filter((field) => result.recipients?.some((recipient) => recipient.id === field.recipientId)),
      );
      setActiveRecipient((current) =>
        result.recipients?.some((recipient) => recipient.id === current)
          ? current
          : result.recipients?.[0]?.id ?? '',
      );
      setSuccess('Recipients saved. Add signing fields to the document.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recipients could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function saveFields() {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const token = csrfToken();
      if (!token) throw new Error('Your security token is missing. Reload this page and try again.');
      const response = await fetch(`/api/envelopes/${initial.id}/fields`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-signet-csrf': token },
        body: JSON.stringify({ fields }),
      });
      const result = (await response.json()) as { fields?: PlacedField[]; error?: { message?: string } };
      if (!response.ok || !result.fields) {
        throw new Error(result.error?.message ?? 'Signing fields could not be saved.');
      }
      setFields(result.fields);
      setSuccess('Signing fields saved to this draft.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Signing fields could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function sendForSignature() {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const token = csrfToken();
      if (!token) throw new Error('Your security token is missing. Reload this page and try again.');
      const response = await fetch(`/api/envelopes/${initial.id}/send`, {
        method: 'POST',
        headers: { 'x-signet-csrf': token },
      });
      const result = (await response.json()) as {
        envelope?: { status: string };
        deliveryFailures?: string[];
        warning?: string;
        error?: { message?: string };
      };
      if (!response.ok && response.status !== 207) {
        throw new Error(result.error?.message ?? 'This agreement could not be sent.');
      }
      if (result.deliveryFailures?.length) {
        setError(result.warning ?? `Invitation delivery failed for ${result.deliveryFailures.join(', ')}.`);
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This agreement could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  function placeOrDrag(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-field-id]');
    if (target) {
      const field = fields.find((item) => item.id === target.dataset.fieldId);
      if (!field) return;
      const fieldBounds = target.getBoundingClientRect();
      dragRef.current = {
        id: field.id,
        offsetX: event.clientX - fieldBounds.left,
        offsetY: event.clientY - fieldBounds.top,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (!activeType || !activeRecipient) return;
    const size = fieldSizes[activeType];
    const nx = clamp((event.clientX - bounds.left) / bounds.width - size.nw / 2, 0, 1 - size.nw);
    const ny = clamp((event.clientY - bounds.top) / bounds.height - size.nh / 2, 0, 1 - size.nh);
    setFields((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        recipientId: activeRecipient,
        page: pageNumber,
        type: activeType,
        nx,
        ny,
        ...size,
        required: true,
        label: fieldLabels[activeType],
        fontSize: 12,
        maxLength: 200,
      },
    ]);
  }

  function moveField(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setFields((current) =>
      current.map((field) =>
        field.id === drag.id
          ? {
              ...field,
              nx: clamp((event.clientX - bounds.left - drag.offsetX) / bounds.width, 0, 1 - field.nw),
              ny: clamp((event.clientY - bounds.top - drag.offsetY) / bounds.height, 0, 1 - field.nh),
            }
          : field,
      ),
    );
  }

  const stopMoving = useCallback(() => {
    dragRef.current = null;
  }, []);

  function updateRecipient(index: number, key: 'name' | 'email', value: string) {
    setRecipients((current) =>
      current.map((recipient, itemIndex) =>
        itemIndex === index ? { ...recipient, [key]: value } : recipient,
      ),
    );
  }

  function addRecipient() {
    setRecipients((current) => [
      ...current,
      { id: '', name: '', email: '', routingOrder: current.length + 1 },
    ]);
  }

  function removeRecipient(index: number) {
    const removedId = recipients[index]?.id;
    setRecipients((current) => current.filter((_, itemIndex) => itemIndex !== index));
    if (removedId) setFields((current) => current.filter((field) => field.recipientId !== removedId));
    if (removedId === activeRecipient) setActiveRecipient('');
  }

  return (
    <main className="prepare-page">
      <header className="prepare-header">
        <Link className="brand" href="/dashboard">
          <span className="prepare-brand-mark">s</span><span>signet</span>
        </Link>
        <div className="prepare-header-center">
          <span className="draft-indicator" />
          <span>Draft saved to your account</span>
        </div>
        <Link className="prepare-back" href="/dashboard"><ArrowLeft size={15} /> Dashboard</Link>
      </header>

      <div className="prepare-content">
        <section className="prepare-title">
          <div>
            <p className="eyebrow">PREPARE AN AGREEMENT</p>
            <h1>{initial.title}</h1>
            <p>{initial.document.filename} · {initial.document.pageCount} {initial.document.pageCount === 1 ? 'page' : 'pages'}</p>
          </div>
          <div className="prepare-title-actions">
            <button className="save-fields-button" type="button" onClick={saveFields} disabled={busy || !recipients.length}>
              <Check size={16} /> Save fields
            </button>
            <button className="send-for-signing-button" type="button" onClick={sendForSignature} disabled={busy || !recipients.length || !fields.length}>
              {busy ? 'Working…' : 'Send for signature'} <ArrowRight size={15} />
            </button>
          </div>
        </section>

        <div className="prepare-grid">
          <aside className="prepare-sidebar">
            <section className="prep-card recipient-card">
              <div className="prep-card-heading">
                <span className="prep-step">1</span>
                <div><h2>Who needs to sign?</h2><p>Recipients sign in this order.</p></div>
              </div>
              <div className="recipient-editor">
                {recipients.map((recipient, index) => (
                  <div className="recipient-entry" key={recipient.id || `new-${index}`}>
                    <span className="recipient-order">{index + 1}</span>
                    <div className="recipient-inputs">
                      <input
                        value={recipient.name}
                        onChange={(event) => updateRecipient(index, 'name', event.target.value)}
                        placeholder="Name (optional)"
                        aria-label={`Recipient ${index + 1} name`}
                        maxLength={100}
                      />
                      <input
                        value={recipient.email}
                        onChange={(event) => updateRecipient(index, 'email', event.target.value)}
                        placeholder="name@example.com"
                        aria-label={`Recipient ${index + 1} email`}
                        type="email"
                        required
                        maxLength={254}
                      />
                    </div>
                    <button className="icon-button remove-recipient" type="button" onClick={() => removeRecipient(index)} aria-label="Remove recipient">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="recipient-actions">
                <button className="text-action" type="button" onClick={addRecipient} disabled={recipients.length >= 50}>
                  <Plus size={14} /> Add recipient
                </button>
                <button className="small-save-button" type="button" onClick={saveRecipients} disabled={busy || !recipients.length}>
                  Save recipients
                </button>
              </div>
            </section>

            <section className="prep-card fields-card">
              <div className="prep-card-heading">
                <span className="prep-step">2</span>
                <div><h2>Add signing fields</h2><p>Select a field, then click on the page.</p></div>
              </div>
              {recipients.length ? (
                <label className="assign-recipient">
                  Assign fields to
                  <select value={activeRecipient} onChange={(event) => setActiveRecipient(event.target.value)}>
                    {recipients.filter((recipient) => recipient.id).map((recipient) => (
                      <option key={recipient.id} value={recipient.id}>{recipient.name || recipient.email}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="inline-hint">Add and save at least one recipient first.</p>
              )}
              <div className="field-tool-grid">
                {(Object.keys(fieldLabels) as FieldType[]).map((type) => (
                  <button
                    className={`field-tool ${activeType === type ? 'active' : ''}`}
                    type="button"
                    key={type}
                    onClick={() => setActiveType(activeType === type ? null : type)}
                    disabled={!recipients.some((recipient) => recipient.id)}
                  >
                    <span>{type === 'signature' ? '✍' : type === 'initials' ? 'Aa' : type === 'date' ? 'D' : type === 'checkbox' ? '☑' : 'T'}</span>
                    {fieldLabels[type]}
                  </button>
                ))}
              </div>
              {activeType && <p className="inline-hint">Click the document to place a {fieldLabels[activeType].toLowerCase()} field. Drag placed fields to move them.</p>}
              {fields.length > 0 && (
                <div className="field-count">
                  <span>{fields.length} field{fields.length === 1 ? '' : 's'} placed</span>
                  <button type="button" onClick={() => setFields([])}>Clear all</button>
                </div>
              )}
            </section>
            {(error || success) && (
              <p className={error ? 'prepare-message error' : 'prepare-message success'} role={error ? 'alert' : 'status'}>
                {error || success}
              </p>
            )}
            <div className="prepare-note">
              <FileText size={15} />
              <p>This is a draft. You can still update recipients and fields before sending.</p>
            </div>
          </aside>

          <section className="document-workspace" aria-label="Document field placement">
            <div className="document-toolbar">
              <div><FileText size={15} /><span>Document preview</span></div>
              <div className="page-controls">
                <button type="button" onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber <= 1} aria-label="Previous page">‹</button>
                <span>Page {pageNumber} of {initial.document.pageCount}</span>
                <button type="button" onClick={() => setPageNumber((page) => Math.min(initial.document.pageCount, page + 1))} disabled={pageNumber >= initial.document.pageCount} aria-label="Next page"><ArrowRight size={13} /></button>
              </div>
            </div>
            <div className="document-scroll-area">
              {pdfError ? (
                <div className="pdf-error" role="alert">{pdfError}</div>
              ) : (
                <div className={`pdf-viewer ${activeType ? 'placement-active' : ''}`} ref={viewerRef}>
                  <Document
                    file={pdfUrl}
                    onLoadError={() => setPdfError('The PDF could not be loaded. Reload the page or upload the document again.')}
                    onSourceError={() => setPdfError('The PDF could not be loaded. Reload the page or upload the document again.')}
                    loading={<div className="pdf-loading">Loading encrypted document…</div>}
                  >
                    <div className="pdf-page-wrap">
                      <Page pageNumber={pageNumber} width={renderWidth} renderAnnotationLayer={false} renderTextLayer={false} />
                      <div
                        className="field-overlay"
                        onPointerDown={placeOrDrag}
                        onPointerMove={moveField}
                        onPointerUp={stopMoving}
                        onPointerCancel={stopMoving}
                      >
                        {fieldsOnPage.map((field) => {
                          const recipient = recipients.find((item) => item.id === field.recipientId);
                          return (
                            <button
                              type="button"
                              key={field.id}
                              data-field-id={field.id}
                              className={`placed-field field-${field.type}${field.recipientId === activeRecipient ? ' field-selected' : ''}`}
                              style={{
                                left: `${field.nx * 100}%`,
                                top: `${field.ny * 100}%`,
                                width: `${field.nw * 100}%`,
                                height: `${field.nh * 100}%`,
                              }}
                              onClick={(event) => event.stopPropagation()}
                              title={`${fieldLabels[field.type]} for ${recipient?.name || recipient?.email || 'recipient'}`}
                            >
                              <span>{fieldLabels[field.type]}</span>
                              {recipient && <small>{recipient.name || recipient.email}</small>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </Document>
                  {!activeType && fieldsOnPage.length === 0 && (
                    <p className="viewer-hint">Choose a field on the left to place it here.</p>
                  )}
                </div>
              )}
            </div>
            <div className="document-workspace-footer">
              <span>Fields are positioned relative to the rendered page.</span>
              <Link href="/dashboard">Save and exit</Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
