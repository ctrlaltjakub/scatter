'use client';
import { RotateCcw } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_PHYSICS_CONFIG, PHYSICS_FIELD_RANGES } from '@/physics/defaults';
import type { PhysicsConfig } from '@/store/types';
import { SliderRow } from './SliderRow';

const FIELD_LABELS: Record<keyof PhysicsConfig, string> = {
  linkedRepelStrength: 'Linked-pair repulsion',
  unlinkedRepelStrength: 'Unlinked-pair repulsion',
  repelRange: 'Repulsion reach',
  linkDistance: 'Link distance',
  linkStrength: 'Link strength',
  collidePadding: 'Collision padding',
  arrowAvoidPadding: 'Arrow keep-out padding',
  ropeMaxSegmentLength: 'Rope anchor spacing',
  ropeMaxAnchorCount: 'Rope max anchors per arrow',
  ropeSmoothing: 'Rope curve smoothness',
  ropeMargin: 'Rope clearance from nodes',
  arrowRepelStrength: 'Arrow ↔ arrow repel strength',
  arrowRepelRange: 'Arrow ↔ arrow repel reach',
  ropeExemptDraggedNodes: 'Ropes pass through dragged nodes (0/1)',
  velocityDecay: 'Velocity decay (friction)',
  alphaDecay: 'Alpha decay (cooling)',
};

export function PhysicsSliders() {
  const physicsConfig = useSettingsStore((s) => s.physicsConfig);
  const setPhysicsConfig = useSettingsStore((s) => s.setPhysicsConfig);
  const resetPhysicsConfig = useSettingsStore((s) => s.resetPhysicsConfig);

  const active: PhysicsConfig = { ...DEFAULT_PHYSICS_CONFIG, ...(physicsConfig ?? {}) };

  const onField = (key: keyof PhysicsConfig) => (v: number) => {
    setPhysicsConfig({ [key]: v });
  };

  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 13 }}>Physics</div>

      {(Object.keys(FIELD_LABELS) as (keyof PhysicsConfig)[]).map((k) => (
        <SliderRow
          key={k}
          label={FIELD_LABELS[k]}
          value={active[k]}
          min={PHYSICS_FIELD_RANGES[k].min}
          max={PHYSICS_FIELD_RANGES[k].max}
          step={PHYSICS_FIELD_RANGES[k].step}
          onChange={onField(k)}
        />
      ))}

      <div className="settings-prompt-footer">
        <button type="button" className="btn btn-secondary" onClick={resetPhysicsConfig}>
          <RotateCcw size={12} /> Reset
        </button>
      </div>
    </>
  );
}
