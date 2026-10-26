export function NodeGenerationError({ error, onRetry, retryDisabled }: {
  error?: string; onRetry?: () => void; retryDisabled?: boolean;
}) {
  if (!error) return null;
  return <div className="node-generation-error" role="alert" data-reading-exclude="true">
    <span>{error}</span>
    {onRetry && <button type="button" onClick={onRetry} disabled={retryDisabled}
      data-tip={retryDisabled ? 'Choose an image model in Settings → Models and generation.' : 'Retry generation'}>
      Retry
    </button>}
  </div>;
}
