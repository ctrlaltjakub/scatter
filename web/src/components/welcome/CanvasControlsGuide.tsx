'use client';

import { useEffect, useRef } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { CanvasControlsCards } from '../CanvasControlsCards';

/** The last onboarding screen, not a second modal over the topic picker. */
export function CanvasControlsGuide({ onContinue }: { onContinue: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <main className="welcome onboarding">
    <section className="canvas-guide settings-modal" aria-labelledby="canvas-guide-title">
      <header className="settings-page-heading">
        <span className="settings-eyebrow"><Check size={14} aria-hidden /> Setup complete</span>
        <h1 id="canvas-guide-title" tabIndex={-1} ref={heading}>Canvas controls</h1>
      </header>
      <CanvasControlsCards variant="onboarding" />
      <footer><button type="button" className="btn btn-primary" onClick={onContinue}>Continue to app <ArrowRight size={15} aria-hidden /></button></footer>
    </section>
  </main>;
}
