'use client';
import { languageInfo } from '@/lib/languages';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Circle, CircleHelp, Copy, FlaskConical, LoaderCircle, Play, Square, Trash2, X } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useModelDiagnosticsStore } from '@/store/useModelDiagnosticsStore';
import { providerAccountLabel } from '@/store/providerSelectors';
import { diagnosticPlan, diagnosticSignature, DIAGNOSTIC_ROLE_LABELS, type DiagnosticResult } from '@/lib/modelDiagnostics';
import { diagnosticCounts, diagnosticResultsMarkdown, DIAGNOSTIC_STATUS_LABELS } from '@/lib/modelDiagnosticResults';
import type { ModelRole } from '@/store/types';
import { modelDisplayName } from '@/lib/modelDisplay';
import { effectiveReasoningEffort, REASONING_LABELS } from '@/lib/modelReasoning';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { CollapsibleSection } from '../dev/CollapsibleSection';

const ROLES: ModelRole[] = ['main', 'secondary', 'interactive', 'image'];
function DiagnosticCheck({ label, model, result, previous, running, disabled, onRun, onStop }: {
  label: string; model?: string; result?: DiagnosticResult; previous: boolean;
  running: boolean; disabled: boolean; onRun: () => void; onStop: () => void;
}) {
  const Icon = !result ? Circle : result.status === 'passed' ? Check : result.status === 'running' ? LoaderCircle : result.status === 'failed' ? X : CircleHelp;
  const title = <span className="model-diagnostic-result-label">{label}{model && <small>{model}</small>}
    {previous && <small>Previous model selection</small>}</span>;
  const meta = <span className="model-diagnostic-result-meta"><span>{result ? DIAGNOSTIC_STATUS_LABELS[result.status] : 'Not run'}</span>
    {result?.milliseconds != null && <small>{(result.milliseconds / 1000).toFixed(1)}s</small>}
    {result && <ChevronRight size={12} aria-hidden="true" />}</span>;
  const actionLabel = `${running ? 'Stop' : 'Run'} ${label}${model ? ` · ${model}` : ''}`;
  return <li className="model-diagnostic-check" data-status={result?.status ?? 'not-run'}>
    <span className={`model-diagnostic-status-icon${running ? ' is-spinning' : ''}`}><Icon size={15} aria-hidden="true" /></span>
    {result ? <details><summary>{title}{meta}</summary>
      <p>{result.code && <code className="model-diagnostic-error-code">{result.code}</code>}{result.detail}</p>
    </details> : <div className="model-diagnostic-check-pending">{title}{meta}</div>}
    <button type="button" className="btn btn-ghost model-diagnostic-check-action" disabled={disabled}
      aria-label={actionLabel} onClick={running ? onStop : onRun}>
      {running ? <Square size={12} /> : <Play size={12} />}{running ? 'Stop' : 'Run'}
    </button>
  </li>;
}

export function ModelDiagnostics({ embedded = false }: { embedded?: boolean }) {
  const settings = useSettingsStore();
  const catalog = useModelCatalogStore(state => state.catalog);
  const state = useModelDiagnosticsStore();
  const [expandedRole, setExpandedRole] = useState<ModelRole | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const plan = useMemo(() => diagnosticPlan(settings), [settings, catalog]);
  const stale = !!state.signature && state.signature !== diagnosticSignature(settings);
  const counts = diagnosticCounts(state.results);
  const finished = state.results.length - counts.running;
  const byKey = new Map(state.results.map(result => [result.key, result]));
  const plannedKeys = new Set(plan.map(job => job.key));
  const start = (role?: ModelRole, checkKey?: string) => {
    setExpandedRole(current => role ?? (plan.some(job => job.target.role === current) ? current : plan[0]?.target.role ?? null));
    setCopyStatus('idle');
    void state.run(role, state.timeoutSeconds, checkKey);
  };
  const copyResults = async () => {
    const text = diagnosticResultsMarkdown({ results: state.results, startedAt: state.startedAt,
      timeoutSeconds: state.timeoutSeconds, stale, error: state.error });
    try { await navigator.clipboard.writeText(text); setCopyStatus('copied'); }
    catch { setCopyStatus('failed'); }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus('idle'), 2500);
  };
  const content = <div className="model-diagnostics">
    <p className="field-help model-diagnostic-intro"><strong>Checks run in parallel, once each.</strong> API tests may incur costs; local models use your hardware.</p>
    <div className="model-diagnostic-actions" role="group" aria-label="Test session controls">
      <button type="button" className="btn btn-secondary" disabled={state.running || !plan.length} onClick={() => start()}><FlaskConical size={15} /> Test all roles</button>
      <button type="button" className="btn btn-secondary" disabled={!state.running} onClick={() => state.stop()}><Square size={13} /> Stop all tests</button>
      <button type="button" className="btn btn-secondary" disabled={state.running || (!state.results.length && !state.error)} onClick={() => { state.clear(); setCopyStatus('idle'); }}><Trash2 size={14} /> Clear results</button>
      <button type="button" className="btn btn-secondary model-diagnostic-copy" disabled={!state.results.length} aria-label="Copy results as Markdown" onClick={() => void copyResults()}>
        {copyStatus === 'copied' ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{copyStatus === 'copied' ? 'Copied (.md)' : 'Copy results (.md)'}</span>
      </button>
    </div>
    <div className="model-diagnostic-options">
      <p className="field-help">Results are kept until the app restarts or reloads.</p>
      <label className="model-test-timeout">Timeout per check <select className="input" value={state.timeoutSeconds} disabled={state.running} onChange={e => state.setTimeoutSeconds(Number(e.target.value))}>
        <option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={180}>3 minutes</option><option value={600}>10 minutes</option><option value={900}>15 minutes</option>
      </select></label>
    </div>
    {copyStatus === 'failed' && <p role="alert" className="field-help settings-search-error">Could not copy results. Allow clipboard access in your browser and try again.</p>}
    {state.error && <p role="alert" className="field-help settings-search-error">{state.error}</p>}
    <details className="model-diagnostic-notes"><summary>Test details and costs</summary>
      <p>Uses the currently selected main model and the models assigned to the other roles, with your current prompts, reasoning levels, and token limits. <strong>No automatic retries.</strong> Image tests generate one image and edit another.</p>
      <p>Tools, search, and provider continuations can require several API requests. Interactive checks allow up to four steps. Server-managed search may also make internal calls; its limits are controlled by your server.</p>
      <p>Providers may queue requests or apply rate limits. Increase the timeout if your local server queues them. <strong>Timeout means inconclusive, not unsupported.</strong></p>
      <p>A pass confirms one sample, not every future answer. Tests do not change model choices or project content. Stop at any time; providers may bill work already performed.</p>
    </details>
    {state.results.length > 0 && <div className="model-diagnostic-session-status">
      <p className="model-diagnostic-counts" role="status"><span>{finished}/{state.results.length} finished</span>
        {Object.entries(counts).filter(([, count]) => count > 0).map(([status, count]) => <span key={status} data-status={status}>
          {status === 'running' && <span className="model-diagnostic-status-icon is-spinning"><LoaderCircle size={13} aria-hidden="true" /></span>}{count} {status}
        </span>)}
      </p>
      <div className="model-diagnostic-progress" role="progressbar" aria-label="Model checks completed" aria-valuemin={0} aria-valuemax={state.results.length} aria-valuenow={finished}>
        <span style={{ width: `${finished / state.results.length * 100}%` }} />
      </div>
    </div>}
    {stale && <p role="status" className="field-help"><strong>Settings changed since these tests.</strong> Results describe the previous configuration.</p>}
    <div className="model-diagnostic-roles">
      {ROLES.map(role => {
        const jobs = plan.filter(job => job.target.role === role);
        const results = state.results.filter(result => result.role === role);
        const previousResults = results.filter(result => !plannedKeys.has(result.key));
        const models = [...new Set(jobs.map(job => `${modelDisplayName(job.target.model)} · ${job.target.provider.name || job.target.provider.preset}`))];
        const mainTarget = role === 'main' ? jobs[0]?.target : undefined;
        const mainReasoning = mainTarget && effectiveReasoningEffort(mainTarget.provider.preset, mainTarget.model, settings.reasoningEffort, mainTarget.info);
        const modelDescription = role === 'main'
          ? mainTarget ? `Test the currently selected main model: ${providerAccountLabel(mainTarget.provider)} — ${modelDisplayName(mainTarget.model)}` : 'No main model selected'
          : models.length ? models.join(' / ') : role === 'image' ? 'No image model selected' : 'No model selected';
        const roleCounts = diagnosticCounts(results);
        const checkCount = jobs.length + previousResults.length;
        const expanded = expandedRole === role && checkCount > 0;
        const checklistId = `${id}-checks-${role}`;
        const modelsId = `${id}-models-${role}`;
        const summaryId = `${id}-summary-${role}`;
        return <section key={role} className="model-diagnostic-role" aria-label={`${DIAGNOSTIC_ROLE_LABELS[role]} tests`}>
          <div className="model-diagnostic-heading">
            <h4><button type="button" className="model-diagnostic-role-toggle" disabled={!checkCount}
              aria-label={`Individual checks for ${DIAGNOSTIC_ROLE_LABELS[role]}`} aria-describedby={`${modelsId} ${summaryId}`}
              aria-expanded={expanded} aria-controls={checklistId}
              onClick={() => setExpandedRole(current => current === role ? null : role)}>
              <ChevronRight size={15} aria-hidden="true" className="sc-collapse-chevron" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
              <span className="model-diagnostic-role-label"><span>{DIAGNOSTIC_ROLE_LABELS[role]}</span>
                <span className="model-diagnostic-models" id={modelsId}>{modelDescription}</span>
                {mainTarget && <small className="model-diagnostic-models">Reasoning: {mainReasoning
                  ? mainTarget.info?.reasoning?.mode === 'toggle' && mainReasoning !== 'off' ? 'On' : REASONING_LABELS[mainReasoning]
                  : 'Server default'} · Language: {languageInfo(settings.generationLanguage).name}</small>}
              </span>
              <span className="model-diagnostic-check-count" id={summaryId}><span>{checkCount} checks</span>
                {results.length > 0 && <span className="model-diagnostic-role-counts">{Object.entries(roleCounts).filter(([, count]) => count > 0).map(([status, count]) => <span key={status} data-status={status}>
                  {status === 'running' && <span className="model-diagnostic-status-icon is-spinning"><LoaderCircle size={12} aria-hidden="true" /></span>}{count} {status}
                </span>)}</span>}
              </span>
            </button></h4>
            <button type="button" className="btn btn-secondary" disabled={state.running || !jobs.length} onClick={() => start(role)}>Test role</button>
          </div>
          <AnimatedCollapse open={expanded} id={checklistId}>
            <div className="model-diagnostic-checklist"><ul aria-label={`${DIAGNOSTIC_ROLE_LABELS[role]} checks and results`}>
              {jobs.map(job => {
                const result = byKey.get(job.key);
                const running = state.running && result?.status === 'running';
                const model = models.length > 1 ? `${modelDisplayName(job.target.model)} · ${job.target.provider.name || job.target.provider.preset}` : undefined;
                return <DiagnosticCheck key={job.key} label={job.test.label} model={model} result={result} previous={false} running={running}
                  disabled={state.running && !running} onRun={() => start(role, job.key)} onStop={() => state.stop(job.key)} />;
              })}
              {previousResults.map(result => {
                const running = state.running && result.status === 'running';
                return <DiagnosticCheck key={result.key} label={result.label} model={`${modelDisplayName(result.model)} · ${result.provider}`}
                  result={result} previous running={running} disabled={!running} onRun={() => {}} onStop={() => state.stop(result.key)} />;
              })}
            </ul></div>
          </AnimatedCollapse>
        </section>;
      })}
    </div>
  </div>;
  return embedded ? <details className="onboarding-details"><summary>Test model capabilities</summary>{content}</details>
    : <CollapsibleSection title="Test model capabilities" description={<>Run <strong>one sample of each task</strong> to check selected models and diagnose failures.</>}>{content}</CollapsibleSection>;
}
