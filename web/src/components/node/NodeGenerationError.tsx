export function NodeGenerationError({ error, onRetry, onIgnore, retryDisabled }: {
  error?: string; onRetry?: () => void; onIgnore?: () => void; retryDisabled?: boolean;
}) {
  if (!error) return null;
  return <div className="node-generation-error" role="alert" data-reading-exclude="true">
    <span>{error}</span>
    {onRetry && <button type="button" onClick={onRetry} disabled={retryDisabled}
      data-tip={retryDisabled ? 'Choose an image model in Settings → Models and generation.' : 'Retry generation'}>
      Retry
    </button>}
    {onIgnore && <button type="button" onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onIgnore(); }}
      data-tip="Hide this warning and keep the draft">Ignore</button>}
  </div>;
}
