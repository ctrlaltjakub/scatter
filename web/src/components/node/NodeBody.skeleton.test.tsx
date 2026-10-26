/**
 * Full-body skeleton (Part 4a).
 *
 * While a node generates as a WHOLE (spawn / regenerate / modify / elaborate)
 * and nothing has streamed in yet, NodeBody shows a multi-line shimmer in place
 * of AdaptiveBullets. The instant text arrives (non-empty displayBody) the real
 * AdaptiveBullets takes over. A node that is NOT generating shows no skeleton.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeBody } from './NodeBody';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { useMediaUrlStore } from '@/store/useMediaUrlStore';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const cls = el.classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) h = 280;
    else if (cls?.contains('sc-ab-freetext')) h = 40;
    else if (cls?.contains('sc-ab-item')) h = 28;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

function setNode(body: string, generating: boolean) {
  const node: ScatterNode = {
    id: 'n0',
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    generating,
    versions: [{ header: 'H', body, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
  const proj = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
}

function setGeneratingMediaNode() {
  const node: ScatterNode = {
    id: 'n0', type: 'media', position: { x: 0, y: 0 }, frozen: false, generating: true,
    versions: [{
      header: 'Image', body: '', createdAt: 0, generatedBy: 'media', contentType: 'media',
      imageGeneration: { prompt: 'owl', promptSource: 'media-prompt', providerId: 'p', model: 'gpt-image-2' },
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
}

function setGeneratingMediaNodeViewingCompletedVersion() {
  const generated = {
    prompt: 'old owl', promptSource: 'media-prompt' as const, providerId: 'p', model: 'gpt-image-2',
  };
  const node: ScatterNode = {
    id: 'n0', type: 'media', position: { x: 0, y: 0 }, frozen: false, generating: true,
    versions: [
      { header: 'Media', body: 'Choose', createdAt: 0, generatedBy: 'media', contentType: 'media' },
      {
        header: 'Image: old owl', body: '', createdAt: 1, generatedBy: 'media', contentType: 'media',
        imageGeneration: generated,
        media: { source: 'asset', kind: 'image', assetId: 'old-image', naturalWidth: 600, naturalHeight: 400 },
      },
      {
        header: 'Image: new owl', body: '', createdAt: 2, generatedBy: 'media', contentType: 'media',
        imageGeneration: { ...generated, prompt: 'new owl' },
      },
    ],
    // A newer request is running in version 3, but the user switched back to
    // the already-complete generated image in version 2.
    currentVersionIndex: 1,
  };
  const project = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
  useMediaUrlStore.setState((state) => ({ urls: { ...state.urls, 'old-image': 'blob:old-image' } }));
}

function setGeneratingTextNodeViewingCompletedVersion() {
  const node: ScatterNode = {
    id: 'n0', type: 'root', position: { x: 0, y: 0 }, frozen: false,
    generating: true,
    generatingVersionIndex: 1,
    versions: [
      { header: 'Readable old version', body: 'The completed version remains readable.', createdAt: 0, generatedBy: 'root' },
      { header: 'New version', body: '', createdAt: 1, generatedBy: 'modify' },
    ],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
  useRewriteStore.setState({
    activeByNode: {
      n0: [{
        id: 'rewrite', nodeId: 'n0', kind: 'whole', abortController: new AbortController(),
      }],
    },
    workingBody: { n0: '' },
    snapshot: {
      n0: {
        preBurstBody: 'The completed version remains readable.',
        preBurstVersionIndex: 0,
        draftVersionIndex: 1,
        generationSessionId: 1,
        preBurstBodyMaxHeight: null,
        preBurstMinBodyHeight: null,
        preBurstBodyHeightFloor: null,
        preBurstFreeTextHeight: null,
        preBurstHadBullets: false,
        preBurstWasAtMin: false,
      },
    },
  });
}

const renderBody = (body: string) =>
  render(
    <NodeBody body={body} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />,
  );

describe('NodeBody — full skeleton', () => {
  beforeEach(() => {
    useRewriteStore.setState({ activeByNode: {}, workingBody: {}, snapshot: {}, pendingSnapDown: {} });
    useMediaUrlStore.setState({ urls: {} });
  });

  it('shows the multi-line skeleton (not AdaptiveBullets) while generating and empty', () => {
    setNode('', true);
    const { container } = renderBody('');
    expect(container.querySelector('.sc-node-skeleton')).not.toBeNull();
    expect(container.querySelector('[data-sc-adaptive="true"]')).toBeNull();
  });

  it('shows AdaptiveBullets (no skeleton) once text has streamed in', () => {
    setNode('Some content has arrived.', true);
    const { container } = renderBody('Some content has arrived.');
    expect(container.querySelector('.sc-node-skeleton')).toBeNull();
    expect(container.querySelector('[data-sc-adaptive="true"]')).not.toBeNull();
  });

  it('shows no skeleton when the node is not generating', () => {
    setNode('', false);
    const { container } = renderBody('');
    expect(container.querySelector('.sc-node-skeleton')).toBeNull();
    expect(container.querySelector('[data-sc-adaptive="true"]')).not.toBeNull();
  });

  it('shows a fixed image-like skeleton for an AI-generating media node', () => {
    setGeneratingMediaNode();
    const { container } = renderBody('');
    expect(container.querySelector('.sc-image-generation-skeleton')).not.toBeNull();
    expect(container.querySelector('.sc-generation-skeleton-icon')).not.toBeNull();
    expect(container.querySelector('.sc-image-skeleton-shape')).toBeNull();
    expect(container.querySelector('.sc-media-chooser')).toBeNull();
  });

  it('keeps a completed image version visible while another version generates', () => {
    setGeneratingMediaNodeViewingCompletedVersion();
    const { container } = renderBody('');
    expect(container.querySelector('.sc-media-img')).not.toBeNull();
    expect(container.querySelector('.sc-image-generation-skeleton')).toBeNull();
  });

  it('keeps a completed text version readable while another version generates', () => {
    setGeneratingTextNodeViewingCompletedVersion();
    const { container, getByText } = renderBody('The completed version remains readable.');
    expect(getByText('The completed version remains readable.')).toBeTruthy();
    expect(container.querySelector('.sc-node-skeleton')).toBeNull();
  });


});
