'use client';
import { useEffect, useState } from 'react';
import { Circle, Square, Play, Trash2, RotateCcw, Download } from 'lucide-react';
import {
  listRecordings,
  saveRecording,
  deleteRecording,
  type Recording,
} from '@/lib/sandboxRecording';

interface Props {
  /** True while a live recording is being captured. */
  recording: boolean;
  /** Live frame count (recorded so far). */
  liveFrameCount: number;
  /** True while a recording is being played back. */
  replaying: boolean;
  /** Replay progress 0..1 (only meaningful when `replaying`). */
  replayProgress: number;
  onStart: () => void;
  onStop: () => Recording | null;
  onReplay: (rec: Recording) => void;
  onStopReplay: () => void;
  onReset: () => void;
}

export function RecordingPanel(p: Props) {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<Recording[]>([]);

  // Refresh list on mount and after save/delete.
  const refresh = () => setSaved(listRecordings());
  useEffect(() => { refresh(); }, []);

  const handleStop = () => {
    const rec = p.onStop();
    if (rec) {
      const labeled = { ...rec, name: name.trim() || rec.name };
      saveRecording(labeled);
      setName('');
      refresh();
    }
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this recording?')) return;
    deleteRecording(id);
    refresh();
  };

  const handleExport = (rec: Recording) => {
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = rec.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || rec.id;
    a.download = `sandbox-recording-${safe}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: 70,
        background: 'var(--mantle)',
        borderTop: '1px solid color-mix(in oklab, var(--overlay0) 25%, transparent)',
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        zIndex: 100,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {!p.recording ? (
          <button
            type="button"
            onClick={p.onStart}
            disabled={p.replaying}
            style={recButtonStyle('record')}
            title="Start recording"
          >
            <Circle size={12} fill="currentColor" /> Record
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            style={recButtonStyle('stop')}
            title="Stop and save"
          >
            <Square size={12} fill="currentColor" /> Stop
          </button>
        )}
        <button
          type="button"
          onClick={p.onReset}
          disabled={p.recording || p.replaying}
          style={recButtonStyle('reset')}
          title="Reset project to canonical sandbox state"
        >
          <RotateCcw size={12} /> Reset
        </button>
      </div>

      {p.recording && (
        <span style={{ color: 'var(--red)', fontWeight: 600 }}>
          ● Recording — {p.liveFrameCount} frames
        </span>
      )}
      {p.replaying && (
        <span style={{ color: 'var(--blue)', fontWeight: 600 }}>
          ▶ Replaying — {Math.floor(p.replayProgress * 100)}%
          <button
            type="button"
            onClick={p.onStopReplay}
            style={{ ...recButtonStyle('stop'), marginLeft: 8 }}
          >
            Stop
          </button>
        </span>
      )}

      <input
        type="text"
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={!p.recording}
        className="input"
        style={{ flex: '0 0 200px', height: 26, fontSize: 12 }}
      />

      <div style={{ flex: 1, display: 'flex', gap: 6, overflowX: 'auto', alignItems: 'center' }}>
        {saved.length === 0 && (
          <span style={{ color: 'var(--overlay1)', fontStyle: 'italic' }}>
            No saved recordings yet.
          </span>
        )}
        {saved.map((rec) => (
          <div
            key={rec.id}
            style={{
              flexShrink: 0,
              padding: '4px 8px',
              background: 'var(--surface0)',
              borderRadius: 'var(--r-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              maxWidth: 240,
              border: '1px solid color-mix(in oklab, var(--overlay0) 25%, transparent)',
            }}
            title={`${rec.frames.length} frames, ${(rec.durationMs / 1000).toFixed(1)}s`}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {rec.name}
            </span>
            <button
              type="button"
              onClick={() => p.onReplay(rec)}
              disabled={p.recording || p.replaying}
              style={{ background: 'none', border: 'none', cursor: 'var(--cur-click)', color: 'var(--blue)', padding: 2 }}
              title="Replay"
            >
              <Play size={12} />
            </button>
            <button
              type="button"
              onClick={() => handleExport(rec)}
              disabled={p.recording || p.replaying}
              style={{ background: 'none', border: 'none', cursor: 'var(--cur-click)', color: 'var(--green)', padding: 2 }}
              title="Export as JSON"
            >
              <Download size={12} />
            </button>
            <button
              type="button"
              onClick={() => handleDelete(rec.id)}
              disabled={p.recording || p.replaying}
              style={{ background: 'none', border: 'none', cursor: 'var(--cur-click)', color: 'var(--overlay1)', padding: 2 }}
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function recButtonStyle(variant: 'record' | 'stop' | 'reset'): React.CSSProperties {
  const colors: Record<string, string> = {
    record: 'var(--red)',
    stop: 'var(--peach)',
    reset: 'var(--overlay1)',
  };
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    fontSize: 12,
    fontWeight: 500,
    color: colors[variant],
    background: 'var(--surface0)',
    border: '1px solid color-mix(in oklab, var(--overlay0) 25%, transparent)',
    borderRadius: 'var(--r-sm)',
    cursor: 'var(--cur-click)',
  };
}
