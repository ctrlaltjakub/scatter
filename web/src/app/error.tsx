'use client';

/**
 * Route-level error boundary. The app previously had ZERO error boundaries, so
 * any uncaught render error blanked the whole page with no clue (physics gone,
 * UI gone). This catches such errors and shows a readable message + the error
 * text, and offers a retry — turning a silent white screen into something
 * diagnosable and recoverable.
 */
import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[app error boundary]', error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        textAlign: 'center',
        fontFamily: 'var(--font-atkinson), system-ui, sans-serif',
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Something went wrong.</h1>
      <p style={{ maxWidth: 480, fontSize: 14, opacity: 0.8 }}>
        Scatter hit an unexpected error and stopped. Your saved work is on this
        device and is not lost. Try again, or reload the page.
      </p>
      <pre
        style={{
          maxWidth: 560,
          maxHeight: 160,
          overflow: 'auto',
          fontSize: 12,
          opacity: 0.7,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {error?.message || String(error)}
      </pre>
      <button
        type="button"
        onClick={reset}
        style={{
          padding: '8px 18px',
          fontSize: 14,
          cursor: 'var(--cur-click)',
          borderRadius: 8,
          border: '1px solid currentColor',
          background: 'transparent',
        }}
      >
        Try again
      </button>
    </div>
  );
}
