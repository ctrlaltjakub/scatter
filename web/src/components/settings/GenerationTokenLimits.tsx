'use client';

import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { GENERATION_LIMITS, normalizeGenerationLimit, type GenerationLimitKey } from '@/lib/generationLimits';

function TokenLimitControl({ limitKey }: { limitKey: GenerationLimitKey }) {
  const stored = useSettingsStore(state => state[limitKey]);
  const setLimit = useSettingsStore(state => state.setGenerationTokenLimit);
  const rule = GENERATION_LIMITS[limitKey];
  const savedValue = normalizeGenerationLimit(limitKey, stored);
  const [value, setValue] = useState(savedValue);
  const draft = useRef(savedValue);
  useEffect(() => { draft.current = savedValue; setValue(savedValue); }, [savedValue]);
  // Keep dragging local, as with the physics sliders. Persist once on release
  // so a large open project does not rerender for every pointer movement.
  const commit = () => { if (draft.current !== savedValue) setLimit(limitKey, draft.current); };
  const id = `generation-limit-${limitKey}`;
  return <div className="settings-token-limit">
    <div className="settings-token-limit-heading">
      <label htmlFor={id}>{rule.label}</label>
      <output htmlFor={id}>{value.toLocaleString('en-US')} tokens</output>
      <button type="button" className="btn-icon" aria-label={`Reset ${rule.label.toLowerCase()} token limit`}
        title={`Restore ${rule.default.toLocaleString('en-US')} tokens`} disabled={value === rule.default}
        onClick={() => setLimit(limitKey, rule.default)}><RotateCcw size={14} /></button>
    </div>
    <input id={id} type="range" min={rule.min} max={rule.max} step={rule.step} value={value}
      aria-describedby={`${id}-help`} aria-valuetext={`${value.toLocaleString('en-US')} tokens`}
      onChange={event => { draft.current = Number(event.target.value); setValue(draft.current); }}
      onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    <div className="settings-token-limit-scale" aria-hidden="true"><span>{rule.min.toLocaleString('en-US')}</span><span>{rule.max.toLocaleString('en-US')}</span></div>
    <p className="field-help" id={`${id}-help`}>
      {limitKey === 'outputTokenCap' ? <>Maximum output for <strong>node and chat generations</strong>. Shorter maintenance tasks use smaller allowances.</>
        : limitKey === 'interactiveOutputTokenCap' ? <>Maximum output <strong>per interactive coding step</strong>. One interactive node can use several steps, each with its own allowance.</>
          : <>Allowance for the <strong>largest secondary tasks</strong>, such as term marking. Short tasks scale proportionally: a 256-token title allowance becomes <strong>{Math.round(256 * value / rule.default).toLocaleString('en-US')} tokens</strong>. Reasoning remains low.</>}
    </p>
  </div>;
}

export function GenerationTokenLimits() {
  return <div className="settings-token-limits">
    <p className="field-help">Token caps limit <strong>reasoning loops and repetitive output</strong>, helping control <strong>waiting time and costs</strong>. On most reasoning models, the limit covers <strong>internal reasoning and visible output together</strong>. It is a ceiling, not a target; it does not force a longer answer.</p>
    {(Object.keys(GENERATION_LIMITS) as GenerationLimitKey[]).map(key => <TokenLimitControl key={key} limitKey={key} />)}
    <div className="settings-callout"><p><strong>Higher limits can increase cost and waiting time.</strong> Low limits can cut off answers, code, or structured data. Changes apply to <strong>future requests</strong>, not a running generation. Custom limits reset if an app update changes their defaults or allowed ranges.</p></div>
    <p className="field-help">The app caps requests at the <strong>model’s reported output maximum</strong> when available. Some providers do not report it, or impose lower limits on a particular route. Input, conversation history, reasoning, and output also need to fit the model’s <strong>context window</strong>. Increasing output does not enlarge that window. These are <strong>per-request limits, not a spending cap</strong>; retries and tool steps can add charges.</p>
  </div>;
}
