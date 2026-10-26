'use client';
import { Paperclip, Sparkles } from 'lucide-react';

export type MediaChooserMode = 'generate' | 'attach';

interface Props {
  mode: MediaChooserMode;
  onChange: (mode: MediaChooserMode) => void;
  generationAvailable?: boolean;
}

/** Compact header switch for an empty media node: AI generation ↔ attachment. */
export function MediaModeToggle({ mode, onChange, generationAvailable = true }: Props) {
  const attaching = mode === 'attach';
  const generationBlocked = attaching && !generationAvailable;
  return (
    <div
      className={`sc-media-mode-control${generationAvailable ? '' : ' generation-disabled'}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Sparkles className={!attaching && generationAvailable ? 'active' : ''} size={14} aria-hidden="true" />
      <button
        type="button"
        className="sc-media-mode-switch"
        role="switch"
        aria-checked={attaching}
        aria-disabled={generationBlocked}
        aria-label={attaching ? 'Switch to AI image generation' : 'Switch to files and links'}
        data-tip={generationBlocked
          ? 'Choose an image model in Settings → Models and generation.'
          : attaching ? 'Files and links' : 'AI image generation'}
        onClick={() => {
          if (!generationBlocked) onChange(attaching ? 'generate' : 'attach');
        }}
      >
        <span className="sc-media-mode-knob" />
      </button>
      <Paperclip className={attaching ? 'active' : ''} size={14} aria-hidden="true" />
    </div>
  );
}
