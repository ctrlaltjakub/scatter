import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { buildInteractiveNode } from './interactiveActions';
import { interactiveMetaResponse } from '@/test/interactiveFixture';
vi.mock('./interactiveProbe', async original => ({ ...await original<typeof import('./interactiveProbe')>(), checkInteractiveDocument: vi.fn(async () => ({ ok: true, errors: [], screenshot: 'data:image/png;base64,fixture' })) }));
import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { resetGenerationSessionsForTests } from './generationSession';
import type { StreamChatOpts } from '@/providers/types';

const calls = vi.hoisted(() => [] as StreamChatOpts[]);
vi.mock('@/providers/registry', async (original) => ({ ...await original<typeof import('@/providers/registry')>(),
  getAdapter: () => ({ capabilities: {}, async *streamChat(_key: string, opts: StreamChatOpts) {
    calls.push(opts);
    const meta = interactiveMetaResponse(opts); if (meta) { yield { delta: meta, done: true }; return; }
    yield { delta: '<!doctype html><html><body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)"><button>Test</button><script>document.body.dataset.ready="yes"</script></body></html>', done: true };
  } }),
}));
beforeEach(() => {
  calls.length = 0; resetGenerationSessionsForTests();
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 'p', preset: 'openai', apiKey: 'test', enabledModels: ['gpt-5.6-luna'] }],
    activeModelRef: { providerId: 'p', model: 'gpt-5.6-luna' }, reasoningEffort: 'max', interactiveReasoningEffort: 'medium',
  });
  const project = createBlankProject('Interactive', 'root');
  project.nodes.root = { id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: false, currentVersionIndex: 0,
    versions: [{ header: 'Demonstration', body: 'An explanation.', createdAt: 1, generatedBy: 'root', contentType: 'interactive' }],
  };
  useGraphStore.setState({ project, activeProjectId: project.id });
});
afterEach(() => { resetGenerationSessionsForTests(); useGraphStore.getState().setProject(null); });

describe('role-specific reasoning requests', () => {
  it('uses the interactive preference while keeping secondary work at Low', async () => {
    await buildInteractiveNode('root', 'Demonstration', 'create');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((opts) => opts.reasoningEffort === 'medium')).toBe(true);
    expect(useGraphStore.getState().project!.nodes.root!.generationError).toBeUndefined();
    calls.length = 0;
    await secondaryTaskCompletion({ system: 'Select terms.', user: 'Therapy.' });
    expect(calls[0]?.reasoningEffort).toBe('low');
    expect(useSettingsStore.getState().reasoningEffort).toBe('max');
  });
});
