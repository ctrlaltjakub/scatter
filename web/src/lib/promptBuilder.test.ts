import { describe, it, expect } from 'vitest';
import {
  buildMessages,
} from './promptBuilder';
import { DEFAULT_PROMPTS } from './promptDefaults';
import { useSettingsStore } from '@/store/useSettingsStore';

describe('buildMessages', () => {
  it('shows parent/grandparent meaning in the visible default context template', () => {
    expect(DEFAULT_PROMPTS.contextBlockTemplate).toContain('immediate source of the query');
    expect(DEFAULT_PROMPTS.contextBlockTemplate).toContain('The grandparent node');
    expect(DEFAULT_PROMPTS.contextBlockTemplate).toContain('not the node the query came from');
  });

  it('allows only provider-generated source links and does not tell the model to initiate search', () => {
    expect(DEFAULT_PROMPTS.base).toMatch(/source citations?.*exception/i);
    expect(DEFAULT_PROMPTS.base).toMatch(/supported claim/i);
    expect(DEFAULT_PROMPTS.base).not.toMatch(/always (?:use|call|perform).*search/i);
  });

  it('builds a root prompt with no context', () => {
    const msgs = buildMessages({
      variant: { kind: 'root', topic: 'fermentation' },
      context: { parent: null, grandparent: null },
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toContain('Scatter');
    // Pass-1 base prompt no longer teaches chips — that moved to the pass-2
    // chip-marking prompts (chipBase / taskAddChips).
    expect(msgs[0]?.content).not.toContain('[[clickable references]]');
    expect(msgs[0]?.content).not.toContain('[[');
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[1]?.content).toContain('"fermentation"');
    // Task root steers the model toward a bulleted compact entry.
    expect(msgs[1]?.content).toContain('bullet');
  });

  it('builds a term-click prompt with parent context', () => {
    const msgs = buildMessages({
      variant: { kind: 'term-click', term: 'lactic acid' },
      context: {
        parent: { header: 'fermentation', body: 'Fermentation is...' },
        grandparent: null,
      },
    });
    const userMsg = msgs[1]?.content ?? '';
    expect(userMsg).toContain('Graph context for this request');
    expect(userMsg).toContain('Parent node (immediate parent of the new node) — "fermentation"');
    expect(userMsg).toContain('"lactic acid"');
  });

  it('builds a follow-up prompt with grandparent + parent context', () => {
    const msgs = buildMessages({
      variant: { kind: 'follow-up', question: 'What is the history?' },
      context: {
        parent: { header: 'lactic acid', body: 'Lactic acid is...' },
        grandparent: { header: 'fermentation', body: 'Fermentation is...' },
      },
    });
    const userMsg = msgs[1]?.content ?? '';
    expect(userMsg).toContain('Grandparent node (parent of that parent) — "fermentation"');
    expect(userMsg).toContain('Parent node (immediate parent of the new node) — "lactic acid"');
    expect(userMsg).toContain('"What is the history?"');
  });

  it('builds a modify prompt including the previous body', () => {
    const msgs = buildMessages({
      variant: {
        kind: 'modify',
        previousBody: 'Lactic fermentation is...',
        instruction: 'be more specific',
      },
      context: { parent: null, grandparent: null },
    });
    const userMsg = msgs[1]?.content ?? '';
    expect(userMsg).toContain('Lactic fermentation is...');
    expect(userMsg).toContain('"be more specific"');
  });

  it('builds a selected-text modification prompt with the exact fragment and instruction', () => {
    const msgs = buildMessages({
      variant: {
        kind: 'modify-selection',
        markedBody: 'Before <<<SELECTED>>>old words<<<END_SELECTED>>> after',
        selectedText: 'old words',
        instruction: 'make this more precise',
        mode: 'encyclopedic',
      },
      context: { parent: null, grandparent: null },
    });
    const user = msgs[1]?.content ?? '';
    expect(user).toContain('<<<SELECTED>>>old words<<<END_SELECTED>>>');
    expect(user).toContain('make this more precise');
    expect(user).toContain('old words');
  });

  it('adds selected text as context to a normal follow-up without changing its routing kind', () => {
    const msgs = buildMessages({
      variant: { kind: 'follow-up', question: 'Why?', selectedText: 'The exact highlighted claim.' },
      context: { parent: null, grandparent: null },
    });
    expect(msgs[1]?.content).toContain('Why?');
    expect(msgs[1]?.content).toContain('The exact highlighted claim.');
  });

  it('builds an explain prompt using the newcomer free-text system (not the bulleted base)', () => {
    const msgs = buildMessages({
      variant: { kind: 'explain', term: 'entropy' },
      context: {
        parent: { header: 'thermodynamics', body: 'Thermodynamics is...' },
        grandparent: null,
      },
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    // Explain system prompt — plain prose for someone new to the field;
    // explicitly NOT the encyclopedia base that forces a two-level bullet list,
    // and no chip markup in pass 1 (the chip pass adds [[ ]] afterwards).
    expect(msgs[0]?.content).toContain('new to this field');
    expect(msgs[0]?.content).not.toContain('two-level');
    expect(msgs[0]?.content).not.toContain('[[');
    // Keeps graph context so the explanation knows which concept, from where.
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[1]?.content).toContain('Parent node (immediate parent of the new node) — "thermodynamics"');
    expect(msgs[1]?.content).toContain('"entropy"');
  });

  it('routes explain expansion through explainBase and the prose-only task', () => {
    useSettingsStore.setState({
      customPrompts: {
        explainBase: 'EXPLAIN SYSTEM',
        taskExpandExplain: 'EXPAND PROSE {markedBody}',
      },
    });
    const msgs = buildMessages({
      variant: {
        kind: 'expand-part',
        mode: 'explain',
        markedBody: 'Before <<<EXPAND>>>short prose<<<END>>> after',
      },
      context: { parent: null, grandparent: null },
    });
    expect(msgs[0]?.content).toBe('EXPLAIN SYSTEM');
    expect(msgs[1]?.content).toContain('EXPAND PROSE Before <<<EXPAND>>>short prose<<<END>>> after');
    useSettingsStore.setState({ customPrompts: undefined });
  });

  it('routes evidence rewrites through the matching format and keeps the protected contract', () => {
    useSettingsStore.setState({
      customPrompts: {
        base: 'ENCYCLOPEDIC SYSTEM',
        explainBase: 'EXPLAIN SYSTEM',
        taskRewriteWithEvidence: 'REWRITE {previousBody}\n{evidenceReport}\n{sourceCatalog}',
      },
    });
    const common = {
      previousBody: 'Old claim.',
      evidenceReport: 'Status: contradicted',
      sourceCatalog: '⟪E1⟫ Source',
    };
    const prose = buildMessages({
      variant: { kind: 'fact-rewrite', ...common, freeText: true },
      context: { parent: { header: 'Parent', body: 'Must not leak' }, grandparent: null },
    });
    expect(prose[0]?.content).toBe('EXPLAIN SYSTEM');
    expect(prose[1]?.content).toContain('⟪E1⟫');
    expect(prose[1]?.content).toContain('Never invent or alter an evidence token');
    expect(prose[1]?.content).not.toContain('Must not leak');

    const encyclopedia = buildMessages({
      variant: { kind: 'fact-rewrite', ...common },
      context: { parent: null, grandparent: null },
    });
    expect(encyclopedia[0]?.content).toContain('ENCYCLOPEDIC SYSTEM');
    useSettingsStore.setState({ customPrompts: undefined });
  });

  it('routes add-chips through the minimal chipBase system, no graph context', () => {
    const msgs = buildMessages({
      variant: { kind: 'add-chips', plainBody: 'Cells make energy.' },
      // Context is supplied but MUST be ignored for the chip pass.
      context: {
        parent: { header: 'biology', body: 'Biology is...' },
        grandparent: null,
      },
    });
    expect(msgs).toHaveLength(2);
    // System is the annotator prompt, NOT the encyclopedia base.
    expect(msgs[0]?.content).toContain('term selector');
    expect(msgs[0]?.content).toContain('REQUIRED RESPONSE FORMAT');
    expect(msgs[0]?.content).not.toContain('encyclopedia');
    // No graph context leaked in.
    expect(msgs[1]?.content).not.toContain('Where the user is in the graph');
    expect(msgs[1]?.content).not.toContain('Parent node');
    // The plain body to annotate is present.
    expect(msgs[1]?.content).toContain('Cells make energy.');
  });
});

describe('buildFollowUpClassifierPrompt', () => {
  it('includes parent node context for the classifier', async () => {
    const { buildFollowUpClassifierPrompt } = await import('./promptBuilder');
    const prompt = buildFollowUpClassifierPrompt({
      question: 'why does this happen?',
      context: {
        parent: { header: 'HPA axis', body: 'Stress response body...' },
        grandparent: null,
      },
    });

    expect(prompt).toContain('Parent node (immediate parent of the new node) — "HPA axis"');
    expect(prompt).toContain('Stress response body...');
    expect(prompt).toContain('"why does this happen?"');
    expect(prompt).not.toContain('"interactive"');
  });

  it('includes grandparent context for the classifier when available', async () => {
    const { buildFollowUpClassifierPrompt } = await import('./promptBuilder');
    const prompt = buildFollowUpClassifierPrompt({
      question: 'gut-brain axis',
      context: {
        parent: { header: 'psychotherapy', body: 'Therapy node body...' },
        grandparent: { header: 'mental health', body: 'Mental health body...' },
      },
    });

    expect(prompt).toContain('Grandparent node (parent of that parent) — "mental health"');
    expect(prompt).toContain('Mental health body...');
    expect(prompt).toContain('Parent node (immediate parent of the new node) — "psychotherapy"');
  });

  it('keeps legacy header placeholder as an alias for parentHeader', async () => {
    const { buildFollowUpClassifierPrompt } = await import('./promptBuilder');
    const prompt = buildFollowUpClassifierPrompt({
      question: 'what does this mean?',
      context: {
        parent: { header: 'attachment theory', body: 'Attachment body...' },
        grandparent: null,
      },
      customPrompts: {
        classifyFollowUp: 'Legacy header={header}; parent={parentHeader}; q={question}',
      },
    });

    expect(prompt).toBe('Legacy header=attachment theory; parent=attachment theory; q=what does this mean?');
  });
});

describe('buildMessages with custom prompts', () => {
  it('uses custom base when set', () => {
    useSettingsStore.setState({ customPrompts: { base: 'CUSTOM BASE' } });
    const msgs = buildMessages({ variant: { kind: 'root', topic: 'test' }, context: { parent: null, grandparent: null } });
    expect(msgs[0]!.content).toBe('CUSTOM BASE');
    useSettingsStore.setState({ customPrompts: undefined });
  });
  it('substitutes placeholders in custom task templates', () => {
    useSettingsStore.setState({ customPrompts: { taskRoot: 'Topic was: {topic}.' } });
    const msgs = buildMessages({ variant: { kind: 'root', topic: 'foo' }, context: { parent: null, grandparent: null } });
    expect(msgs[1]!.content).toContain('Topic was: foo.');
    useSettingsStore.setState({ customPrompts: undefined });
  });
});
