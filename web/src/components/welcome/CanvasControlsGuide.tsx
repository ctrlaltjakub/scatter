'use client';

import { useEffect, useRef } from 'react';
import { ArrowRight, Check, Move, MousePointer2, Pin, ScanLine } from 'lucide-react';

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
      <div className="canvas-guide-grid">
        <section><Move aria-hidden /><h2>Move and zoom</h2>
          <p><strong>Pan:</strong> click and drag empty canvas with a mouse or trackpad, or use <kbd>WASD</kbd>.</p>
          <p><strong>Zoom:</strong> scroll the mouse wheel, pinch the trackpad, or use <kbd>Q</kbd> / <kbd>E</kbd>.</p>
          <p className="field-help">Over scrollable text, hold <kbd>Ctrl</kbd> / <kbd>⌘</kbd> while scrolling to zoom.</p>
        </section>
        <section><Pin aria-hidden /><h2>Place a node</h2>
          <p>Drag its <strong>header</strong> to move it. Click the <strong>pin</strong> in its top-right corner to keep it in place or release it.</p>
          <p>You can also drag it away from a connected node. Release when the pin lights up.</p>
        </section>
        <section><MousePointer2 aria-hidden /><h2>Explore a term</h2>
          <p>Hover over an <strong className="canvas-guide-term">underlined term</strong> for a preview. Click to create a connected node or visit the one that already exists.</p>
        </section>
        <section><ScanLine aria-hidden /><h2>Use the reading ruler</h2>
          <p>Select a text node, then press <kbd>↑</kbd> <kbd>↓</kbd> to read by line or <kbd>←</kbd> <kbd>→</kbd> to read by word. Press <kbd>Esc</kbd> to stop.</p>
        </section>
      </div>
      <footer><button type="button" className="btn btn-primary" onClick={onContinue}>Continue to app <ArrowRight size={15} aria-hidden /></button></footer>
    </section>
  </main>;
}
