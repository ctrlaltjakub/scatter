import { Move, MousePointer2, Pin, ScanLine } from 'lucide-react';
import styles from './CanvasControlsCards.module.css';

/** The same fixed canvas gestures appear after setup and above the editable shortcuts. */
export function CanvasControlsCards({ variant }: { variant: 'onboarding' | 'settings' }) {
  const Heading = variant === 'onboarding' ? 'h2' : 'h4';
  return (
    <div className={`${styles.grid} ${variant === 'settings' ? styles.settings : ''}`}>
      <section>
        <Heading><Move aria-hidden />Move and zoom</Heading>
        <p><strong>Pan: click and drag</strong> an empty area of the canvas with a mouse or trackpad, or use <kbd>WASD</kbd>.</p>
        <p><strong>Zoom:</strong> scroll the mouse wheel over an empty area of the canvas, pinch the trackpad, or use <kbd>Q</kbd> / <kbd>E</kbd>.</p>
        <p className={styles.note}>Over scrollable text, hold <kbd>Ctrl</kbd> / <kbd>⌘</kbd> while scrolling to zoom.</p>
      </section>
      <section>
        <Heading><Pin aria-hidden />Place a node</Heading>
        <p>Drag its <strong>header</strong> to move it. Click the <strong>pin</strong> in its top-right corner to keep it in place or release it.</p>
        <p>You can also drag it away from a connected node to pin it. Release when the pin lights up.</p>
      </section>
      <section>
        <Heading><MousePointer2 aria-hidden />Explore a term</Heading>
        <p>Hover over an <strong className={styles.term}>underlined term</strong> for a preview. Click to create a connected node or visit the one that already exists.</p>
      </section>
      <section>
        <Heading><ScanLine aria-hidden />Use the reading ruler</Heading>
        <p>Select a text node, then press <kbd>↑</kbd> <kbd>↓</kbd> to read by line or <kbd>←</kbd> <kbd>→</kbd> to read by word. Press <kbd>Esc</kbd> to stop.</p>
      </section>
    </div>
  );
}
