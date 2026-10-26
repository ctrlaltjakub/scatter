'use client';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

/** Reusable slider + numeric input row used in the Physics dev panel. */
export function SliderRow({ label, value, min, max, step, onChange }: Props) {
  return (
    <div className="settings-slider-row">
      <label style={{ width: 200, fontSize: 12.5, color: 'var(--subtext0)' }}>{label}</label>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <input
        type="number"
        aria-label={`${label} value`}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="input"
        style={{ width: 80, height: 30, fontSize: 12, flex: '0 0 80px' }}
      />
    </div>
  );
}
