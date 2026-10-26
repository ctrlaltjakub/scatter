import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { APP_FONT_ID } from '@/lib/imageEditFonts';
import { emptyDoc } from '@/lib/imageEditElements';
import { ImageEditorPanel } from './ImageEditorPanel';
import { ImageEditorViewportController } from '@/lib/imageEditorViewport';

function props(overrides: Partial<ComponentProps<typeof ImageEditorPanel>> = {}): ComponentProps<typeof ImageEditorPanel> {
  const doc = emptyDoc();
  return {
    verIdx: 0,
    total: 1,
    busy: false,
    ready: true,
    dirty: false,
    tool: 'select',
    crop: doc.crop,
    color: '#111111',
    accentHex: null,
    strokeWidth: 6,
    fontId: APP_FONT_ID,
    fontSize: 32,
    adjustments: doc.adjustments,
    viewportController: new ImageEditorViewportController(),
    onSwitchVersion: vi.fn(),
    onDeleteVersion: vi.fn(),
    onSave: vi.fn(),
    showGenerate: false,
    generateLabel: 'Regenerate from subject',
    canGenerate: true,
    onGenerate: vi.fn(),
    onTool: vi.fn(),
    onRotate90: vi.fn(),
    onFineAngle: vi.fn(),
    onClearCrop: vi.fn(),
    onColor: vi.fn(),
    onStrokeWidth: vi.fn(),
    onFont: vi.fn(),
    onFontSize: vi.fn(),
    onAdjust: vi.fn(),
    onResetAdjust: vi.fn(),
    onGestureEnd: vi.fn(),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    ...overrides,
  };
}

describe('ImageEditorPanel generation action', () => {
  it('hides the action for file/link images and shows it for AI-generated images', () => {
    const { rerender } = render(<ImageEditorPanel {...props()} />);
    expect(screen.queryByRole('button', { name: 'Regenerate from subject' })).toBeNull();

    rerender(<ImageEditorPanel {...props({ showGenerate: true })} />);
    expect(screen.getByRole('button', { name: 'Regenerate from subject' })).toBeEnabled();
  });

  it('uses the complete dynamic semantic-field label', () => {
    render(<ImageEditorPanel {...props({
      showGenerate: true,
      generateLabel: 'Regenerate from subject and question',
    })} />);
    expect(screen.getByRole('button', { name: 'Regenerate from subject and question' })).toBeInTheDocument();
  });

  it('greys out regeneration for an existing AI image when no model is selected', () => {
    render(<ImageEditorPanel {...props({ showGenerate: true, canGenerate: false })} />);
    expect(screen.getByRole('button', { name: 'Regenerate from subject' })).toBeDisabled();
  });
});

describe('ImageEditorPanel navigation', () => {
  it('exposes Crop as the same accessible disclosure as node side-panel groups', () => {
    const onTool = vi.fn();
    const { rerender } = render(<ImageEditorPanel {...props({ onTool })} />);
    const crop = screen.getByRole('button', { name: 'Crop' });
    expect(crop).toHaveAttribute('aria-expanded', 'false');
    expect(crop.querySelector('.side-disclosure-chevron')).toBeTruthy();
    crop.click();
    expect(onTool).toHaveBeenCalledWith('crop');
    rerender(<ImageEditorPanel {...props({ tool: 'crop' })} />);
    expect(screen.getByRole('button', { name: 'Done cropping' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Rotate clockwise' })).toBeEnabled();
  });
  it('places editor-local undo and redo in the version-switcher row', () => {
    render(<ImageEditorPanel {...props({ canUndo: true, canRedo: false })} />);
    const undo = screen.getByRole('button', { name: 'Undo image edit' });
    expect(undo).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Redo image edit' })).toBeDisabled();
    expect(undo.closest('.versions-row')).toBeTruthy();
  });

  it('offers six tools including Hand and exposes the compact zoom controls', () => {
    render(<ImageEditorPanel {...props()} />);
    for (const name of ['Select', 'Hand', 'Pen', 'Highlighter', 'Text', 'Arrow']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.getByRole('slider', { name: 'Image zoom' })).toHaveAttribute('aria-valuetext', '100%');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeDisabled();
  });

  it('normalizes the font previews in the annotation picker', () => {
    render(<ImageEditorPanel {...props({ fontId: 'opendyslexic' })} />);
    const picker = screen.getByRole('button', { name: 'Text font' });
    expect((picker.querySelector('.ie-dd-value') as HTMLElement).style.fontSizeAdjust).toBe('0.496');
    fireEvent.click(picker);
    expect((screen.getByRole('button', { name: /Press Start 2P/ }).querySelector('.ie-dd-item-label') as HTMLElement).style.fontSizeAdjust)
      .toBe('0.496');
    expect((screen.getByRole('button', { name: /Atkinson Hyperlegible/ }).querySelector('.ie-dd-item-label') as HTMLElement).style.fontSizeAdjust)
      .toBe('none');
  });

  it('updates the logarithmic slider and enables Fit away from the fitted view', () => {
    const viewportController = new ImageEditorViewportController();
    viewportController.configure({
      viewportWidth: 800,
      viewportHeight: 600,
      region: { x: 0, y: 0, width: 800, height: 600 },
    });
    viewportController.setZoom(2);
    render(<ImageEditorPanel {...props({ viewportController })} />);
    expect(screen.getByRole('slider', { name: 'Image zoom' })).toHaveAttribute('aria-valuetext', '200%');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fit' })).toBeEnabled();
  });
});
