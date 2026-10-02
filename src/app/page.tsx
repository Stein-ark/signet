import Image from 'next/image';
import Link from 'next/link';
import { ArrowDown, ArrowRight, FileCheck2, Fingerprint, LockKeyhole } from 'lucide-react';

const principles = [
  {
    icon: Fingerprint,
    title: 'Know who signed',
    description: 'Every recipient verifies control of their email before they can sign.',
  },
  {
    icon: LockKeyhole,
    title: 'Keep documents private',
    description: 'Documents are encrypted before they reach local or cloud storage.',
  },
  {
    icon: FileCheck2,
    title: 'Keep a clear record',
    description: 'A tamper-evident audit trail and signed certificate travel with every completed file.',
  },
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Signet home">
          <Image src="/logo.png" alt="" width={38} height={32} priority />
          <span>signet</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link href="#how-it-works">How it works</Link>
          <Link href="#trust">Trust &amp; security</Link>
        </nav>
        <a className="header-cta" href="#how-it-works">
          See how it works <ArrowRight aria-hidden="true" size={16} />
        </a>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow"><span /> SIGNING, WITH THE DETAILS TAKEN CARE OF</p>
          <h1 id="hero-title">A signature is a promise. Make it <em>count.</em></h1>
          <p className="hero-description">
            Send important documents for signing with identity checks, clear consent and a
            certificate that keeps the whole story together.
          </p>
          <a className="primary-cta" href="#how-it-works">
            Discover the signing journey <ArrowRight aria-hidden="true" size={17} />
          </a>
          <p className="hero-footnote">Thoughtfully designed for agreements that matter.</p>
        </div>

        <div className="document-scene" aria-label="Preview of a signed agreement">
          <div className="scene-orbit orbit-one" />
          <div className="scene-orbit orbit-two" />
          <div className="document-card">
            <div className="document-topline"><span /> PRIVATE AGREEMENT <span>01 / 04</span></div>
            <div className="document-heading">
              <span className="document-kicker">AGREEMENT</span>
              <h2>Made with<br />confidence.</h2>
              <p>A clear agreement starts with a careful process.</p>
            </div>
            <div className="document-lines">
              <i /><i /><i /><i /><i className="short" />
            </div>
            <div className="signature-block">
              <div>
                <span className="signature-script">Jordan Ellis</span>
                <span className="signature-rule" />
                <span className="signature-caption">SIGNED ELECTRONICALLY</span>
              </div>
              <div className="verified-mark"><Fingerprint size={19} /><span>IDENTITY<br />VERIFIED</span></div>
            </div>
            <div className="document-seal"><LockKeyhole size={13} /> DOCUMENT SEALED</div>
          </div>
          <div className="status-card">
            <span className="status-icon"><FileCheck2 size={18} /></span>
            <span><strong>All signatures collected</strong><small>Audit trail secured</small></span>
            <span className="status-check">✓</span>
          </div>
          <div className="scene-caption">EVERY STEP, ACCOUNTED FOR</div>
        </div>
        <a className="scroll-cue" href="#how-it-works" aria-label="Scroll to how it works">
          <ArrowDown size={15} />
        </a>
      </section>

      <section className="principles" id="trust" aria-label="Our principles">
        <div className="principles-intro">
          <p className="eyebrow">BUILT AROUND WHAT MATTERS</p>
          <h2>More than a signature.</h2>
        </div>
        {principles.map(({ icon: Icon, title, description }, index) => (
          <article className="principle" key={title}>
            <span className="principle-number">0{index + 1}</span>
            <Icon aria-hidden="true" size={20} strokeWidth={1.6} />
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <section className="journey" id="how-it-works">
        <p className="eyebrow">A BETTER WAY TO GET IT SIGNED</p>
        <h2>From first page to final proof.</h2>
        <p>
          Prepare your document, invite the right people, and let each signer review and
          complete their part. When it is done, the signed PDF and its evidence stay together.
        </p>
      </section>

      <footer className="site-footer">
        <Link className="brand" href="/" aria-label="Signet home">
          <Image src="/logo.png" alt="" width={28} height={24} />
          <span>signet</span>
        </Link>
        <span>Careful signing for documents that matter.</span>
        <span>© {new Date().getFullYear()} Signet</span>
      </footer>
    </main>
  );
}
