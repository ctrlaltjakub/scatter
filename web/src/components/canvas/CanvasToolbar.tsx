'use client';
import { useGraphStore } from '@/store/useGraphStore';
import { useEditorStore } from '@/store/useEditorStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { NavActions } from '@/components/NavActions';
import { SidebarModelPicker } from '@/components/SidebarModelPicker';
import { SourceControls } from '@/components/sources/SourceControls';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { useChatTableStore } from '@/store/useChatTableStore';

interface Props {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Toolbar only renders when the sidebar is collapsed — that's when the
   *  user has no other access to the navigation icons. */
  sidebarCollapsed: boolean;
  /** While the sidebar is peeking open, its own model picker is visible, so
   *  we suppress the toolbar's duplicate. */
  peeking?: boolean;
  onOpenSettings: () => void;
}

/**
 * Floating glass pill in the canvas top-right. When the sidebar is open the
 * sidebar footer holds these controls and this toolbar hides entirely. When
 * the sidebar is collapsed the toolbar pops in with the same navigation icons.
 */
export function CanvasToolbar({ containerRef, sidebarCollapsed, peeking, onOpenSettings }: Props) {
  const hasProject = useGraphStore((s) => s.project !== null);
  const editorOpen = useEditorStore((s) => s.open);
  const imageEditorOpen = useImageEditorStore((s) => s.open);
  const interactiveViewerOpen = useInteractiveViewerStore((s) => s.open);
  const sourceViewerOpen = useSourceUiStore((s) => s.viewer !== null);
  const tableViewerOpen = useChatTableStore((s) => !!s.target);

  if (!hasProject) return null;
  // The full-window "Edit text" editor supplies its own controls — hide the
  // canvas top-right nav while it's open (unlike normal canvas mode).
  if (editorOpen || imageEditorOpen || interactiveViewerOpen || sourceViewerOpen || tableViewerOpen) return null;
  // Shown only while the sidebar is collapsed AND not peeking — when the
  // sidebar slides open on hover, the whole top-right panel (nav + model
  // picker) gets out of the way; its controls live in the sidebar then.
  if (!sidebarCollapsed || peeking) return null;

  return (
    <div className="canvas-topright">
      <div className="canvas-toolbar">
        <NavActions
          containerRef={containerRef}
          onOpenSettings={onOpenSettings}
        />
      </div>
      {/* Active-model switcher as the second row of the same panel. */}
      <SidebarModelPicker placement="down" variant="toolbar" />
      <SourceControls />
    </div>
  );
}
