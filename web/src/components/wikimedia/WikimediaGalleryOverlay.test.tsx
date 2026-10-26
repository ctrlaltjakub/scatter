import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useWikimediaGalleryStore } from '@/store/useWikimediaGalleryStore';
import WikimediaGalleryOverlay from './WikimediaGalleryOverlay';

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const result = {
  pageId: 42,
  fileTitle: 'File:Neuron diagram.svg',
  filePageUrl: 'https://commons.wikimedia.org/wiki/File:Neuron_diagram.svg',
  thumbnailUrl: 'https://upload.wikimedia.org/neuron-thumb.svg',
  originalUrl: 'https://upload.wikimedia.org/neuron.svg',
  caption: 'A labeled neuron and its processes',
  description: 'A scientific illustration identifying the major parts of a neuron.',
  relevance: 'The diagram spatially connects the node’s explanation to the parts of a neuron.',
  creator: 'Example illustrator',
  creatorUrl: 'https://commons.wikimedia.org/wiki/User:Example',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  creditLine: 'Example illustrator / Wikimedia Commons',
  width: 1600,
  height: 1200,
  mime: 'image/svg+xml',
};

function seed() {
  const node: ScatterNode = {
    id: 'n1',
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{
      header: 'Neuron structure and signaling',
      body: 'Neurons send signals through specialized structures.',
      createdAt: 10,
      generatedBy: 'term-click',
      contentType: 'encyclopedic',
      wikimediaImages: {
        schemaVersion: 1,
        bodyFingerprint: 'body',
        providerId: 'provider',
        model: 'model',
        searchedAt: 10,
        resultLimit: 5,
        results: [result],
      },
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('gallery', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  useWikimediaGalleryStore.getState().openGallery(node.id, 10, 0);
}

describe('WikimediaGalleryOverlay', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains('wikimedia-gallery-viewport') ? 800 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains('wikimedia-gallery-viewport') ? 600 : 0;
    });
    seed();
  });

  afterEach(() => {
    act(() => {
      useWikimediaGalleryStore.getState().close();
      useGraphStore.getState().setProject(null);
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the image immediately with details, Commons links, spawn, and editor navigation', async () => {
    const { container } = render(<WikimediaGalleryOverlay />);

    expect(screen.getByRole('dialog', { name: 'Free image' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: result.caption })).toBeTruthy();
    expect(screen.getByText(result.relevance)).toBeTruthy();
    expect(screen.getByText(result.description)).toBeTruthy();
    expect(screen.getByRole('link', { name: /View on Wikimedia/ })).toHaveAttribute(
      'href',
      result.filePageUrl,
    );
    expect(screen.getByRole('button', { name: 'Spawn media node' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fit/ })).toBeTruthy();

    const image = screen.getByRole('img', { name: result.caption });
    const description = screen.getByText(result.relevance);
    const panel = screen.getByLabelText('Free image details');
    const topbar = container.querySelector('.wikimedia-gallery-topbar')!;
    const exit = screen.getByRole('button', { name: /Exit/ });
    const links = screen.getByRole('heading', { name: 'Links' });
    const metadata = screen.getByRole('heading', { name: 'Image metadata' });
    expect(description.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel).toContainElement(description);
    expect(topbar).toContainElement(screen.getByLabelText('Image 1 of 1'));
    expect(topbar).toContainElement(exit);
    expect(links.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(image).not.toHaveClass('is-loaded');
    fireEvent.load(image);
    await waitFor(() => expect(image).toHaveClass('is-loaded'));
    await waitFor(() => expect(image.getAttribute('style')).toContain('scale(0.5)'));
    expect(container.querySelector('.wikimedia-gallery-image-description')).toBeNull();
  });

  it('closes from the editor-style Exit button, outside click, and Escape', () => {
    const { container } = render(<WikimediaGalleryOverlay />);
    const exit = screen.getByRole('button', { name: /Exit/ });
    expect(exit).toHaveClass('text-editor-exit');
    fireEvent.click(exit);
    expect(useWikimediaGalleryStore.getState().open).toBe(false);

    act(() => useWikimediaGalleryStore.getState().openGallery('n1', 10, 0));
    fireEvent.mouseDown(container.querySelector('.wikimedia-gallery-stage')!);
    expect(useWikimediaGalleryStore.getState().open).toBe(false);

    act(() => useWikimediaGalleryStore.getState().openGallery('n1', 10, 0));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useWikimediaGalleryStore.getState().open).toBe(false);
  });

  it('uses equal outer padding and one stable viewer frame', () => {
    const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
    const stage = /\.text-editor-stage\.wikimedia-gallery-stage\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const group = /\.text-editor-group\.wikimedia-gallery-group\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const panel = /\.text-editor-panel\.wikimedia-gallery-panel\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const card = /\.text-editor-card\.wikimedia-gallery-card\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(stage).toContain('padding: 24px');
    const viewport = /\.wikimedia-gallery-viewport\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(group).toContain('width: 100%');
    expect(group).toContain('height: 100%');
    expect(panel).toContain('height: 100%');
    expect(panel).toContain('align-self: stretch');
    expect(card).toContain('height: 100%');
    expect(card).toContain('max-height: 100%');
    expect(card).toContain('align-self: stretch');
    expect(viewport).toContain('background: transparent');
    expect(viewport).toContain('cursor: var(--cur-hand)');
    expect(viewport).toContain('user-select: none');
    const panning = /\.wikimedia-gallery-viewport\.is-panning\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(panning).toContain('cursor: var(--cur-grab)');
    expect(panel).toContain('cursor: var(--cur-pointer)');
    expect(panel).toContain('user-select: text');
    const scroll = /\.wikimedia-gallery-panel-scroll\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(scroll).toContain('cursor: var(--cur-text)');
    expect(scroll).toContain('user-select: text');
  });
});
