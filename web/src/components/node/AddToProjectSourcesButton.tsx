'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, FilePlus2, LoaderCircle } from 'lucide-react';
import type { NodeVersion } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { addNodeVersionToSources } from '@/lib/nodeSource';

export function AddToProjectSourcesButton({ version, disabled = false, panel = true }: {
  version: NodeVersion; disabled?: boolean; panel?: boolean;
}) {
  const projectId = useGraphStore(state => state.project?.id ?? '');
  const [status, setStatus] = useState<'idle' | 'adding' | 'added'>('idle');
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => { setStatus('idle'); setError(''); request.current++;
    return () => { request.current++; };
  }, [projectId, version.createdAt, version.body]);
  const size = panel ? 15 : 14;
  return <>
    <button type="button" className={panel ? 'side-action' : undefined}
      disabled={disabled || !projectId || !version.body.trim() || status !== 'idle'}
      data-tip="Add this text to project sources without term markings, including citation numbers and linked bibliography. Remove it through Sources."
      onClick={event => {
        event.stopPropagation(); const id = ++request.current;
        setStatus('adding'); setError('');
        void addNodeVersionToSources(projectId, version).then(() => {
          if (request.current === id) setStatus('added');
        }).catch((cause: unknown) => {
          if (request.current !== id) return;
          setStatus('idle'); setError(cause instanceof Error ? cause.message : 'Could not add the text. Open Sources to check the import.');
        });
      }}>
      <span className={panel ? 'side-action-icon' : undefined}>{status === 'adding' ? <LoaderCircle size={size} className="animate-spin" />
        : status === 'added' ? <Check size={size} /> : <FilePlus2 size={size} />}</span>
      <span aria-live="polite">{status === 'adding' ? 'Adding to sources…' : status === 'added' ? 'Added to sources' : 'Add to project sources'}</span>
    </button>
    {error && <p className="source-import-error" role="alert">{error}</p>}
  </>;
}
