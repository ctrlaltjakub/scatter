import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  graphHistorySlicesEqual,
  preserveProjectPresentation,
} from './historySemantics';
import type { NodeVersion, Project, ScatterNode } from '@/store/types';
import { appendChatAnswer, createChatNode } from './chat/model';

function version(patch: Partial<NodeVersion> = {}): NodeVersion {
  return {
    header: 'Header',
    body: 'Body',
    createdAt: 1,
    generatedBy: 'manual',
    ...patch,
  };
}

function node(ver = version()): ScatterNode {
  return {
    id: 'n1',
    type: 'term-click',
    position: { x: 10, y: 20 },
    frozen: false,
    versions: [ver],
    currentVersionIndex: 0,
  };
}

function project(n = node()): Project {
  return {
    id: 'p1',
    name: 'Project',
    createdAt: 1,
    updatedAt: 2,
    rootNodeId: 'n1',
    nodes: { n1: n },
    arrows: {},
    groups: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('semantic graph history comparison', () => {
  it('ignores presentation, runtime generation, sizing, and fact-check changes', () => {
    const before = project();
    const current = before.nodes.n1!;
    const currentVersion = current.versions[0]!;
    const after = {
      ...before,
      updatedAt: 99,
      viewport: { x: 100, y: 100, zoom: 0.5 },
      selection: ['n1'],
      nodes: {
        n1: {
          ...current,
          position: { x: 99, y: 88 },
          currentVersionIndex: 0,
          generating: true,
          bulletsCollapsed: true,
          versions: [{
            ...currentVersion,
            width: 600,
            interactiveBuild: { request: 'A counter', state: 'building', steps: [] },
            factCheck: {
              complete: {
                schemaVersion: 1,
                bodyFingerprint: 'hash',
                versionCreatedAt: 1,
                providerId: 'openrouter',
                model: 'model',
                startedAt: 1,
                completedAt: 2,
                complete: true,
                units: [],
                failedUnitIds: [],
              },
            },
          }],
        },
      },
    } satisfies Project;

    expect(graphHistorySlicesEqual({ project: before }, { project: after })).toBe(true);
  });

  it('detects semantic body and interactive document changes', () => {
    const before = project(node(version({
      interactive: {
        html: '<main>one</main>',
        request: 'request',
        providerId: 'openrouter',
        model: 'model',
      },
    })));
    const current = before.nodes.n1!;
    const currentVersion = current.versions[0]!;
    const bodyChanged = {
      ...before,
      nodes: {
        n1: {
          ...current,
          versions: [{ ...currentVersion, body: 'Changed' }],
        },
      },
    };
    const interactiveChanged = {
      ...before,
      nodes: {
        n1: {
          ...current,
          versions: [{
            ...currentVersion,
            interactive: { ...currentVersion.interactive!, html: '<main>two</main>' },
          }],
        },
      },
    };

    expect(graphHistorySlicesEqual({ project: before }, { project: bodyChanged })).toBe(false);
    expect(graphHistorySlicesEqual({ project: before }, { project: interactiveChanged })).toBe(false);
  });

  it('does not serialize unchanged large interactive versions', () => {
    const largeInteractive = {
      html: 'x'.repeat(2_000_000),
      request: 'request',
      providerId: 'openrouter',
      model: 'model',
    };
    const versions = Array.from({ length: 10 }, (_, index) => version({
      createdAt: index,
      interactive: largeInteractive,
    }));
    const beforeNode = { ...node(), versions };
    const before = project(beforeNode);
    const after = project({
      ...beforeNode,
      bulletsCollapsed: true,
      versions: versions.map((item, index) => (
        index === 0 ? { ...item, width: 700 } : item
      )),
    });
    const stringify = vi.spyOn(JSON, 'stringify');

    expect(graphHistorySlicesEqual({ project: before }, { project: after })).toBe(true);
    expect(stringify).not.toHaveBeenCalled();
  });

  it('preserves current presentation while restoring semantic content', () => {
    const current = project(node(version({ body: 'Current', width: 700 })));
    current.nodes.n1!.position = { x: 200, y: 300 };
    current.nodes.n1!.bulletsCollapsed = true;
    const target = project(node(version({ body: 'Restored', width: 400 })));

    const restored = preserveProjectPresentation(current, target)!;
    expect(restored.nodes.n1!.versions[0]!.body).toBe('Restored');
    expect(restored.nodes.n1!.versions[0]!.width).toBe(700);
    expect(restored.nodes.n1!.position).toEqual({ x: 200, y: 300 });
    expect(restored.nodes.n1!.bulletsCollapsed).toBe(true);
  });
  it('restores interrupted chat snapshots without reviving network activity', () => {
    const blank = createChatNode({ id: 'n1', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 600 });
    const generating = appendChatAnswer(blank, { turnId: 't', createdAt: 2, question: 'Question' });
    const restored = preserveProjectPresentation(project(blank), project(generating))!.nodes.n1!;
    expect(restored.generating).toBe(false);
    expect(restored.generatingVersionIndex).toBeUndefined();
    expect(restored.versions.at(-1)?.chat?.state).toBe('interrupted');
    const stillLive = preserveProjectPresentation(project(generating), project(generating))!.nodes.n1!;
    expect(stillLive.generating).toBe(true);
    expect(stillLive.versions.at(-1)?.chat?.state).toBe('generating');
  });
});
