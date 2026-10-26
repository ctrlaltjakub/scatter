import { create } from 'zustand';
import type { ModelRole } from './types';
import { useSettingsStore } from './useSettingsStore';
import { diagnosticPlan, diagnosticSignature, runDiagnosticPlan, type DiagnosticResult } from '@/lib/modelDiagnostics';

let controller: AbortController | undefined;
const checks = new Map<string, AbortController>();
const normalizeTimeout = (seconds: number) => Number.isFinite(seconds) ? Math.min(900, Math.max(30, seconds)) : 180;
/** Deliberately runtime-only: no credentials, outputs, or diagnostic history
 * are written to settings exports, cloud sync, projects, or canvas undo. */
export const useModelDiagnosticsStore = create<{
  running: boolean; results: DiagnosticResult[]; signature?: string; startedAt?: number; error?: string;
  timeoutSeconds: number; setTimeoutSeconds: (seconds: number) => void;
  run: (role?: ModelRole, timeoutSeconds?: number, checkKey?: string) => Promise<void>;
  stop: (checkKey?: string) => void; clear: () => void;
}>((set, get) => ({
  running: false, results: [], timeoutSeconds: 180,
  setTimeoutSeconds: seconds => { if (!get().running) set({ timeoutSeconds: normalizeTimeout(seconds) }); },
  run: async (role, timeoutSeconds = get().timeoutSeconds, checkKey) => {
    if (get().running) return;
    const settings = structuredClone(Object.fromEntries(Object.entries(useSettingsStore.getState()).filter(([, value]) => typeof value !== 'function'))) as ReturnType<typeof useSettingsStore.getState>;
    const plan = diagnosticPlan(settings);
    const jobs = plan.filter(job => (!role || job.target.role === role) && (!checkKey || job.key === checkKey)); if (!jobs.length) return;
    const order = new Map(plan.map((job, index) => [job.key, index]));
    const signature = diagnosticSignature(settings);
    const previous = get().signature === signature ? get().results.filter(result => !jobs.some(job => job.key === result.key)) : [];
    controller = new AbortController();
    checks.clear();
    const timeout = normalizeTimeout(timeoutSeconds);
    set({ running: true, signature, startedAt: Date.now(), results: previous, error: undefined, timeoutSeconds: timeout });
    try {
      await runDiagnosticPlan(jobs, settings, { signal: controller.signal, timeoutMs: timeout * 1000,
        onController: (key, request) => { if (request) checks.set(key, request); else checks.delete(key); },
        onResult: result => set(state => ({ results: state.results.some(r => r.key === result.key)
          ? state.results.map(r => r.key === result.key ? result : r)
          : [...state.results, result].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)) })) });
    } catch { set({ error: 'The test session could not start. No automatic retry was made. Check browser support and try again.' }); }
    finally { controller = undefined; checks.clear(); set({ running: false }); }
  },
  stop: checkKey => (checkKey ? checks.get(checkKey) : controller)?.abort(new DOMException('Stopped by user', 'AbortError')),
  clear: () => { if (!get().running) set({ results: [], signature: undefined, startedAt: undefined, error: undefined }); },
}));
