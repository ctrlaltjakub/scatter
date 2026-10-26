'use client';
import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_BULLET_SIZING_CONFIG, BULLET_SIZING_FIELD_RANGES } from '@/lib/bulletSizingDefaults';
import type { BulletSizingConfig } from '@/store/types';
import { SliderRow } from './SliderRow';

const FIELD_LABELS: Record<keyof BulletSizingConfig, string> = {
  safetyFraction: 'Safety margin (fraction of body)',
  safetyMinPx: 'Safety margin (absolute floor, px)',
  overflowTolerance: 'Cascade overflow tolerance (px)',
  underflowTolerance: 'Cascade underflow tolerance (px)',
  maxAdjustmentIter: 'Cascade iteration limit',
};

const FIELD_HELP: Record<keyof BulletSizingConfig, ReactNode> = {
  safetyFraction:
    <>Adds <strong>extra height</strong> above the minimum needed for content. 0.40 adds 40%. The <strong>larger</strong> of this margin and the pixel minimum below is used.</>,
  safetyMinPx:
    <>Sets the <strong>minimum extra height in pixels</strong>. This protects short nodes when the percentage margin is smaller.</>,
  overflowTolerance:
    <>Allows this much <strong>overflow before collapsing a bullet</strong>. Smaller values fit more tightly but may cause repeated expansion and collapse.</>,
  underflowTolerance:
    <>Requires this much <strong>spare space before expanding a bullet</strong>. Smaller values fill the node more aggressively.</>,
  maxAdjustmentIter:
    <>Limits <strong>expansion and collapse attempts per change</strong>. Prevents an endless adjustment loop.</>,
};

export function BulletSizingSliders() {
  const bulletSizingConfig = useSettingsStore((s) => s.bulletSizingConfig);
  const setBulletSizingConfig = useSettingsStore((s) => s.setBulletSizingConfig);
  const resetBulletSizingConfig = useSettingsStore((s) => s.resetBulletSizingConfig);

  const active: BulletSizingConfig = { ...DEFAULT_BULLET_SIZING_CONFIG, ...(bulletSizingConfig ?? {}) };

  const onField = (key: keyof BulletSizingConfig) => (v: number) => {
    setBulletSizingConfig({ [key]: v });
  };

  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Bullet sizing</div>
      <p className="field-help" style={{ marginBottom: 14 }}>
        Controls <strong>node height</strong> and when <strong>bullets expand or collapse</strong> to fit the available space.
      </p>

      {(Object.keys(FIELD_LABELS) as (keyof BulletSizingConfig)[]).map((k) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <SliderRow
            label={FIELD_LABELS[k]}
            value={active[k]}
            min={BULLET_SIZING_FIELD_RANGES[k].min}
            max={BULLET_SIZING_FIELD_RANGES[k].max}
            step={BULLET_SIZING_FIELD_RANGES[k].step}
            onChange={onField(k)}
          />
          <div className="field-help" style={{ marginLeft: 4, marginTop: 2, fontSize: 12 }}>
            {FIELD_HELP[k]}
          </div>
        </div>
      ))}

      <div className="settings-prompt-footer">
        <button type="button" className="btn btn-secondary" onClick={resetBulletSizingConfig}>
          <RotateCcw size={12} /> Reset
        </button>
      </div>
    </>
  );
}
