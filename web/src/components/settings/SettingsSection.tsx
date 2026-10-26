'use client';

import type { ReactNode } from 'react';

export function SettingsSection({
  title,
  description,
  children,
  className = '',
  id,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`settings-section ${className}`}>
      <div className="settings-section-heading">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingsToggle({
  title,
  description,
  checked,
  onChange,
}: {
  title: ReactNode;
  description: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle-row">
      <span>
        <strong>{title}</strong>{' '}
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-switch" aria-hidden="true" />
    </label>
  );
}
