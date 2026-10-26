'use client';
import { VersionCounter } from '@/components/VersionCounter';
import {
  ChevronsUpDown, ListChevronsUpDown,
  FileText, Palette,
  Trash, ChevronLeft, ChevronRight, ChevronDown, RotateCcw, ListRestart,
  SquareArrowOutUpRight, ImagePlus, SquarePen,
  Sparkles, TriangleAlert, DollarSign,
  Check, SearchCheck, CheckCheck, SpellCheck, Square,
  Images,
  LoaderCircle,
  FileSymlink,
  ArrowRightLeft,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useEditorStore } from '@/store/useEditorStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { colorToCss } from '@/lib/groupColor';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useActiveRecords, targetsEqual } from '@/store/useRewriteStore';
import {
  elaborateNode, expandPart, regenerateNode, popSelectedBullet, redoTermMarking,
  cancelNodeGeneration, cancelNodeGenerationCascade,
  rewriteNodeWithEvidence,
  retypeNodeToText,
  type ExpandPartTarget,
} from '@/lib/generate';
import { replaceMedia, reloadMedia } from '@/lib/mediaActions';
import { regenerateImageInMediaNode } from '@/lib/imageGeneration';
import { isEditableImageMedia, isGifMedia } from '@/lib/imageEditActions';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { currentContentType, isExplainContentType, isStandaloneInteractive } from '@/lib/nodeContentType';
import { spawnInteractiveNode } from '@/lib/interactiveActions';
import { InteractiveNodeActions } from '@/components/node/InteractiveNodeActions';
import {
  computePanelTargetOffset, stepPanelMotion, PANEL_MOTION,
  type PanelMotionState,
} from '@/lib/panelFollow';
import { NodeGroupMenu, hasGroupedAutoDescendants } from './NodeGroupMenu';
import { useImageGenerationAvailable } from '@/hooks/useImageGenerationAvailable';
import { useInteractiveGenerationAvailable } from '@/hooks/useInteractiveGenerationAvailable';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import {
  factCheckAvailability,
  startFactCheck,
  stopFactCheck,
} from '@/lib/factCheck';
import { factCheckTaskKey, useFactCheckTaskStore } from '@/store/useFactCheckTaskStore';
import { wikimediaTaskKey, useWikimediaTaskStore } from '@/store/useWikimediaTaskStore';
import { startWikimediaDiscovery, versionSupportsAutomaticFreeImages, wikimediaSearchAvailability } from '@/lib/wikimediaDiscovery';
import { getFreeImageRecommendationSet } from '@/lib/freeImageRecommendations';
import { createScatterFromBranch } from '@/store/projectActions';
import { collectAutomaticBranchNodeIds } from '@/lib/projectBranch';
import { ChatSideActions } from '@/components/chat/ChatSideActions';
import { AnswerSideActions } from '@/components/chat/AnswerSideActions';
import { AddNodeMenu } from './AddNodeMenu';
import { isEmptyTextNode } from '@/lib/emptyNodes';
import { GoogleSearchSuggestions } from '@/components/node/GoogleSearchSuggestions';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { SidePanelDisclosureContext, type SidePanelSection } from './SidePanelDisclosure';
import { EditHeaderButton } from '@/components/node/EditHeaderButton';
import { AddToProjectSourcesButton } from '@/components/node/AddToProjectSourcesButton';

// Exported for Canvas's focus-fit (the camera fit covers the panel too).
// Must match .side-panel's CSS width (and .node-type-menu, which edge-aligns).
export const PANEL_W = 248;
export const PANEL_GAP = 12; // gap between panel and node
// Panel sits on the LEFT of the node. Place panel's right edge at
// (nodeX - PANEL_GAP) so its left edge is at (nodeX - PANEL_GAP - PANEL_W).
const LEFT_OFFSET = -(PANEL_W + PANEL_GAP);

/** One measured/moving stack: menus and attribution must never drift apart.
 * The camera-fit selector includes both panels, without changing node sizing. */
function NodeSidePanelStack({ panelRef, style, snippets, disclosure, children }: {
  panelRef: RefObject<HTMLDivElement>;
  style?: CSSProperties;
  snippets?: string[];
  disclosure: { open: SidePanelSection | null; setOpen: (section: SidePanelSection | null) => void };
  children: ReactNode;
}) {
  return <div ref={panelRef} className="node-side-panel-stack node-actions-panel"
    style={{ ...style, gap: PANEL_GAP }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <SidePanelDisclosureContext.Provider value={disclosure}><div className="side-panel">{children}</div></SidePanelDisclosureContext.Provider>
    {!!snippets?.length && <section className="side-panel google-search-panel" aria-label="Gemini API search suggestions">
      <h3 className="google-search-panel-heading">Forced by Gemini API:</h3>
      <GoogleSearchSuggestions snippets={snippets} showLabel={false} />
    </section>}
  </div>;
}

/**
 * Floating action panel that appears beside the currently-selected node.
 * Lives inside the canvas-world (so it pans/scales with viewport) but is NOT
 * a physics body — its position is computed from the selected node's
 * position; physics doesn't know about it.
 *
 * The panel auto-disappears when the user clicks anywhere else on the
 * canvas (selection clears → panel unmounts). No explicit collapse handle.
 *
 * Action set (node-final v2):
 *   - Versions row: previous / next / regenerate / delete
 *   - "Expand whole" — calls elaborateNode (extends the whole body)
 *   - "Expand selected" — calls expandPart on the active section
 *     (freetext when collapsed or no active bullet; the active
 *     bullet's L2 children otherwise)
 *   - "Edit" disclosure — opens the full-window article editor and exposes
 *     expansion/extraction actions
 *   - "Group" — visual grouping (not wired)
 *   - "Pin / Unpin" — freeze the node against physics
 *
 * The Modify and Ask-follow-up actions live in the NodeFollowUpBar
 * (the bottom-docked panel) — separated from the side-panel button
 * list so they get their own dedicated input surface.
 */
export function NodeSidePanel() {
  const autoFreeImages = useSettingsStore(s => s.autoFreeImages);
  const project = useGraphStore((s) => s.project);
  const imageGenerationAvailable = useImageGenerationAvailable();
  const interactiveGenerationAvailable = useInteractiveGenerationAvailable();
  // Keep fact-check availability reactive when the main provider/model changes.
  useSettingsStore((s) => s.activeModelRef);
  useSettingsStore((s) => s.providers);
  useSettingsStore((s) => s.secondaryModelRef);
  useSettingsStore((s) => s.secondaryUseSameModel);
  useSettingsStore((s) => s.modelCompatibilityOverrides);
  // Image-search availability also depends on asynchronously loaded model
  // capabilities. Existing recommendations do not otherwise cause this panel
  // to rerender when that catalog arrives, which could leave Redo disabled.
  useModelCatalogStore((s) => s.catalog);
  const updateNode = useGraphStore((s) => s.updateNode);
  const deleteNodeCascade = useGraphStore((s) => s.deleteNodeCascade);
  const assignNodeToGroup = useGraphStore((s) => s.assignNodeToGroup);
  const assignSubtreeToGroup = useGraphStore((s) => s.assignSubtreeToGroup);
  const createGroupFromNode = useGraphStore((s) => s.createGroupFromNode);
  const openEditor = useEditorStore((s) => s.openEditor);

  const [openSection, setOpenSection] = useState<SidePanelSection | null>(null);
  const [creatingBranchProject, setCreatingBranchProject] = useState(false);
  const [branchProjectError, setBranchProjectError] = useState<string | null>(null);
  // Auto-collapse disclosures whenever the selected
  // node changes (including the deselect → no-selection transition
  // that briefly re-renders this panel before it unmounts). Belt
  // and suspenders: the panel unmounting itself also tears down
  // the popover, but this catches the "selection moved to a
  // different node" case where the panel persists.

  const selectedId = project?.selection.length === 1 ? project.selection[0]! : '';
  const selectedNode = selectedId ? project?.nodes[selectedId] : undefined;
  const selectedVersionCreatedAt = selectedNode
    ?.versions[selectedNode.currentVersionIndex]
    ?.createdAt;
  const factPanelOpen = useCitationPanelStore(
    (s) => s.mode === 'fact-check'
      && s.nodeId === selectedId
      && s.factVersionCreatedAt === selectedVersionCreatedAt,
  );
  const factTaskRunning = useFactCheckTaskStore(
    (s) => selectedId && selectedVersionCreatedAt != null
      ? !!s.tasks[factCheckTaskKey(selectedId, selectedVersionCreatedAt)]?.running
      : false,
  );
  const wikimediaPanelOpen = useCitationPanelStore(
    (s) => s.mode === 'wikimedia'
      && s.nodeId === selectedId
      && s.wikimediaVersionCreatedAt === selectedVersionCreatedAt,
  );
  const wikimediaTask = useWikimediaTaskStore(
    (s) => selectedId && selectedVersionCreatedAt != null
      ? s.tasks[wikimediaTaskKey(selectedId, selectedVersionCreatedAt)]
      : undefined,
  );
  useEffect(() => {
    setOpenSection(null);
    setBranchProjectError(null);
  }, [selectedId]);
  // Results can also open from an answer's inline actions. Keep that action
  // exclusive with these menus without closing a restored results panel.
  useEffect(() => {
    if (factPanelOpen) setOpenSection('fact');
    else if (wikimediaPanelOpen) setOpenSection('wikimedia');
    else setOpenSection(current => current === 'fact' || current === 'wikimedia' ? null : current);
  }, [selectedId, factPanelOpen, wikimediaPanelOpen]);
  // The panel's transform is owned imperatively by the rAF loop below —
  // NOT by React render — so the node-follow stays glued to the live
  // physics position (read fresh each frame) while only the within-node
  // scroll/expand offset eases. `transform` is deliberately kept OUT of
  // the JSX `style` prop so React re-renders never clobber the loop's
  // value. Hoisted above the early returns so the hook order is stable.
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!selectedId) return;
    let raf = 0;
    let motion: PanelMotionState | null = null;
    let lastSel = '';
    const loop = () => {
      const el = panelRef.current;
      if (el) {
        const proj = useGraphStore.getState().project;
        const sel = proj && proj.selection.length === 1 ? proj.selection[0]! : '';
        const np = sel ? proj!.nodes[sel] : undefined;
        if (sel && np) {
          const z = useLiveViewportStore.getState().zoom || 1;
          // Base = node's LIVE top-left in world space, read fresh every
          // frame so the panel stays glued to the node during physics /
          // drag with no easing lag. The panel sits to the node's left.
          const lp = useLivePositionsStore.getState().positions[sel];
          const baseX = (lp?.x ?? np.position.x) + LEFT_OFFSET;
          const baseY = lp?.y ?? np.position.y;

          // Active section's top within the node, in CSS px. activeIdx
          // null = freetext / top stop → rest at the node top (offset 0);
          // a bullet active → track that bullet's top edge. The node lives
          // in a sibling subtree, found by data-node-id; its anchors carry
          // the same data-sc-anchor tags the scrollbar reads.
          const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${sel}"]`);
          let target: number;
          if (nodeEl) {
            const nodeRect = nodeEl.getBoundingClientRect();
            const aIdx = useActiveIdxStore.getState().byNodeId[sel] ?? null;
            let sectionTopWithinNode = 0;
            // When bullets are collapsed there's no expanded bullet field
            // (the list is clipped away), so rest at the node top.
            if (aIdx !== null && !np.bulletsCollapsed) {
              const aEl = nodeEl.querySelector<HTMLElement>(`[data-sc-anchor="b-${aIdx}"]`);
              if (aEl) {
                sectionTopWithinNode = (aEl.getBoundingClientRect().top - nodeRect.top) / z;
              }
            }
            target = computePanelTargetOffset({
              sectionTopWithinNode,
              // border-box height of the node card (the follow-up bar is
              // absolutely positioned outside it, so this is the visible
              // node border the panel's bottom must not cross).
              nodeHeight: nodeRect.height / z,
              // offsetHeight is zoom-independent layout px; recomputed each
              // frame so panel-size changes (e.g. opening Edit markdown)
              // re-clamp automatically.
              panelHeight: el.offsetHeight,
              edgePriority: 'top',
            });
          } else {
            target = motion?.pos ?? 0;
          }

          // Snap on (re)mount and whenever the selection flips to another
          // node; otherwise advance the slow trapezoidal glide (short
          // accel → slow cruise → short decel) one frame toward the target.
          if (motion === null || sel !== lastSel) {
            motion = { pos: target, vel: 0 };
            lastSel = sel;
          } else {
            motion = stepPanelMotion(motion, target, PANEL_MOTION);
          }
          el.style.transform = `translate3d(${baseX}px, ${baseY + motion.pos}px, 0)`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    // Run once synchronously (inside the layout effect, before paint) so
    // the first frame is already correctly positioned — no flash at the
    // origin before the first rAF tick.
    loop();
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);
  // Subscribe to the selected node's activeIdx and bulletsCollapsed
  // so "Expand selected" routes to the right target. activeIdx is
  // null when no L1 bullet is forced active (cascade's default
  // fill); in that case Expand-selected targets the freetext.
  const activeIdx = useActiveIdxStore(
    (s) => s.byNodeId[selectedId] ?? null,
  );
  const bulletsCollapsed = useGraphStore(
    (s) => !!s.project?.nodes[selectedId]?.bulletsCollapsed,
  );
  // Subscribe to in-flight rewrite records for the selected node so the
  // "Expand selected" button disables itself when (a) a whole rewrite
  // is in flight (whole owns the entire body — no partials allowed),
  // or (b) THIS specific section is already being expand-part'd. Other
  // sections remain clickable; switching the selection to a different
  // bullet re-enables the button.
  const activeRecords = useActiveRecords(selectedId);

  if (!project || project.selection.length !== 1) return null;
  const nodeId = project.selection[0]!;
  const node = project.nodes[nodeId];
  if (!node) return null;
  const v = node.versions[node.currentVersionIndex];
  const imageRecommendationSet = getFreeImageRecommendationSet(v);
  if (!v) return null;
  const contentType = currentContentType(node);
  const emptyText = isEmptyTextNode(node);
  const isExplain = isExplainContentType(contentType);
  const factState = v.factCheck;
  const factReport = factState?.pending ?? factState?.complete;
  const hasFactCheck = !!factReport;
  const factIncomplete = !!factState?.pending && !factState.pending.complete;
  const factAvailable = factCheckAvailability();
  const displayedVersionGenerating = !!node.generating
    && (node.generatingVersionIndex == null
      || node.generatingVersionIndex === node.currentVersionIndex);
  // Manual browsing never depends on a provider key or vision capability.
  const imageDisclosureDisabled = !imageRecommendationSet && displayedVersionGenerating;
  const imageSearchAvailable = wikimediaSearchAvailability();
  const imageRedoDisabled = !!wikimediaTask?.running || displayedVersionGenerating || !v.body.trim() || !imageSearchAvailable.available;
  const beginFactCheck = (mode: 'new' | 'again' | 'continue') => {
    setOpenSection('fact');
    void startFactCheck(node.id, mode).catch((error) => {
      console.error('[scatter] fact check failed to start', error);
    });
  };
  const showFactResults = () => {
    if (!factReport) return;
    useCitationPanelStore.getState().openFact(
      node.id,
      v.createdAt,
      factReport.units[0]?.id,
    );
    if (useLiveViewportStore.getState().zoom < 0.35) {
      useGraphStore.getState().requestFitNodes([node.id], 'panels');
    }
  };

  const onSwitchVersion = (delta: -1 | 1) => {
    const next = Math.max(0, Math.min(node.versions.length - 1, node.currentVersionIndex + delta));
    updateNode(node.id, { currentVersionIndex: next });
  };

  const onDelete = () => {
    if (node.generating) {
      // Existing-node rewrites own a provisional version; cancel removes just
      // that current work. A fresh one-version node has no completed fallback,
      // so stop every stream in its subtree before normal cascade deletion.
      const stoppedKind = cancelNodeGeneration(node.id, { discardCurrentWork: true });
      if (stoppedKind === 'rewrite') return;
      cancelNodeGenerationCascade(node.id);
      deleteNodeCascade(node.id);
      return;
    }
    if (node.versions.length > 1) {
      const versions = [...node.versions];
      versions.splice(node.currentVersionIndex, 1);
      updateNode(node.id, {
        versions,
        currentVersionIndex: Math.max(0, node.currentVersionIndex - 1),
      });
    } else {
      deleteNodeCascade(node.id);
    }
  };

  // "Expand selected" routing — mirrors the prototype's per-section
  // expand-button logic:
  //   - bulletsCollapsed OR no L1 active → expand the freetext
  //   - otherwise → expand the active L1 bullet's children
  const expandTarget: ExpandPartTarget = (isExplain || bulletsCollapsed || activeIdx === null)
    ? { kind: 'freetext' }
    : { kind: 'bullet', index: activeIdx };
  const expandSelectedLabel = expandTarget.kind === 'freetext'
    ? 'Expand opening paragraph'
    : 'Expand bullet';
  const onExpandSelected = () => {
    void expandPart(node.id, expandTarget);
  };
  // Two conflict cases disable the button:
  //   1. A WHOLE rewrite is in flight → no partials allowed.
  //   2. A partial targeting THIS section is already running → only
  //      one rewrite per section. Switching the selected bullet
  //      re-evaluates and may re-enable.
  const wholeRunning = !!activeRecords?.some((r) => r.kind === 'whole');
  const samePartialRunning = !!activeRecords?.some(
    (r) => r.kind === 'partial' && targetsEqual(r.target, expandTarget),
  );
  const expandSelectedDisabled = emptyText || wholeRunning || samePartialRunning;

  // "Pop selected" — only when a bullet is selected AND expanded (activeIdx
  // set, bullets not collapsed) and no whole-body rewrite is in flight.
  const popDisabled = bulletsCollapsed || activeIdx === null || wholeRunning;
  const onPopSelected = () => {
    if (activeIdx === null) return;
    void popSelectedBullet(node.id, activeIdx);
  };

  // C.8 — Group color cascade for the side panel. The panel lives
  // outside the .node DOM tree so the inline-var cascade from
  // NodeView doesn't reach it; we set the same vars here based on
  // the selected node's group. React's style prop only writes/
  // removes the listed CSS custom properties — it never clears
  // `transform`, which the rAF loop above owns.
  const groupColor =
    (node.groupId ? project.groups[node.groupId]?.color : undefined) ?? project.color;
  // The root is the origin of every branch — it can't be grouped (its colour
  // would dominate the whole map). The Group control is faded for it.
  const isRoot = project.rootNodeId === node.id;
  const branchNodeIds = collectAutomaticBranchNodeIds(
    node.id,
    Object.values(project.arrows),
  );
  const branchHasGeneratingNode = [...branchNodeIds].some(
    (id) => !!project.nodes[id]?.generating,
  );
  const branchHasGroupedDescendants = hasGroupedAutoDescendants(
    node.id,
    project.nodes,
    project.arrows,
  );
  const toggleSection = (section: 'text' | 'group' | 'fact') => {
    if (
      (openSection === 'wikimedia' && wikimediaPanelOpen)
      || (openSection === 'fact' && factPanelOpen)
    ) {
      useCitationPanelStore.getState().close();
    }
    setOpenSection((current) => current === section ? null : section);
  };
  let panelStyle: React.CSSProperties | undefined;
  if (groupColor) {
    // E.2 — panel BASE stays the translucent white from globals.css;
    // we override only the accent vars so hover / pressed / tag /
    // popover surfaces colour up. The `--side-panel-bg` override was
    // dropped to keep the body white per user feedback.
    const gc = colorToCss(groupColor);
    const sty: Record<string, string> = {
      '--tint-1': `color-mix(in oklab, ${gc} 5%, transparent)`,
      '--tint-2': `color-mix(in oklab, ${gc} 10%, transparent)`,
      '--tint-3': `color-mix(in oklab, ${gc} 22%, transparent)`,
      '--tint-4': `color-mix(in oklab, ${gc} 30%, transparent)`,
      '--control-accent': gc,
      '--node-tag-bg': `color-mix(in oklab, ${gc} 25%, transparent)`,
    };
    panelStyle = sty as React.CSSProperties;
  }

  // Chat answer navigation also updates currentVersionIndex, so this follows
  // only the active answer/alternative, never all conversation versions.
  const panelProps = { panelRef, style: panelStyle, snippets: v.googleSearchSuggestions,
    disclosure: { open: openSection, setOpen: (section: SidePanelSection | null) => {
      const panel = useCitationPanelStore.getState();
      if (panel.nodeId === selectedId && ((panel.mode === 'fact-check' && section !== 'fact')
        || (panel.mode === 'wikimedia' && section !== 'wikimedia'))) panel.close();
      setOpenSection(section);
    } } };

  if (node.chat) return <NodeSidePanelStack {...panelProps}>
    <ChatSideActions key={node.id} node={node} />
  </NodeSidePanelStack>;

  if (currentContentType(node) === 'answer') return <NodeSidePanelStack {...panelProps}>
    <AnswerSideActions key={node.id} node={node} />
  </NodeSidePanelStack>;

  if (isStandaloneInteractive(node)) return <NodeSidePanelStack {...panelProps}>
    <InteractiveNodeActions key={node.id} node={node} isRoot={isRoot}/>
  </NodeSidePanelStack>;

  // Media nodes get a simplified panel with direct header/image actions.
  if (currentContentType(node) === 'media') {
    return (
      <NodeSidePanelStack {...panelProps}>
        <div className="side-panel-content">
          <div className="versions-row">
            <div className="versions-row-cluster">
              <button
                type="button"
                disabled={node.currentVersionIndex === 0}
                onClick={() => onSwitchVersion(-1)}
                data-tip="Previous version"
                aria-label="Previous version"
              >
                <ChevronLeft size={14} />
              </button>
              <VersionCounter current={node.currentVersionIndex + 1} total={node.versions.length} />
              <button
                type="button"
                disabled={node.currentVersionIndex >= node.versions.length - 1}
                onClick={() => onSwitchVersion(1)}
                data-tip="Next version"
                aria-label="Next version"
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <div className="versions-row-actions">
              <button
                type="button"
                onClick={() => {
                  if (v.imageGeneration) void regenerateImageInMediaNode(node.id);
                  else reloadMedia(node.id);
                }}
                disabled={!v.media || !!node.generating || (!!v.imageGeneration && !imageGenerationAvailable)}
                data-tip={v.imageGeneration
                  ? imageGenerationAvailable
                    ? 'Generate another image from the complete saved prompt'
                    : 'Choose an image model in Settings → Models and generation.'
                  : 'Reload this media'}
                aria-label={v.imageGeneration ? 'Regenerate image' : 'Reload media'}
              >
                <RotateCcw size={14} />
              </button>
              <button
                type="button"
                onClick={onDelete}
                data-tip={node.generating ? 'Stop generation and delete current work' : 'Delete version (or whole node)'}
                aria-label="Delete"
              >
                <Trash size={14} />
              </button>
            </div>
          </div>

          <AddNodeMenu key={node.id} nodeId={node.id} />

          <button
            type="button"
            className={'side-action side-disclosure-trigger' + (openSection === 'group' ? ' toggled' : '')}
            onClick={() => toggleSection('group')}
            data-tip="Assign this node to a group, or create a new one"
            aria-expanded={openSection === 'group'}
            aria-controls={`node-group-tools-${node.id}`}
            aria-label="Group"
          >
            <span className="side-action-icon"><Palette size={15} /></span>
            <span className="side-action-label">Group</span>
            <span className="side-disclosure-chevron">
              {openSection === 'group' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>
          <AnimatedCollapse open={openSection === 'group'}>
            <div
              id={`node-group-tools-${node.id}`}
              className="side-disclosure-content side-disclosure-content--group"
            >
              <NodeGroupMenu
              nodeGroupId={node.groupId ?? null}
              branchHasGroupedDescendants={branchHasGroupedDescendants}
              groups={Object.values(project.groups)}
              onAssign={(gid) => assignNodeToGroup(node.id, gid)}
              onAssignSubtree={(gid) => assignSubtreeToGroup(node.id, gid)}
              onNewFromNode={(spread) => { createGroupFromNode(node.id, spread); }}
              />
            </div>
          </AnimatedCollapse>

          <EditHeaderButton node={node} />

          {v.media && isEditableImageMedia(v.media) && (() => {
            const gif = isGifMedia(v.media);
            const busy = !!node.generating;
            const blocked = gif || busy;
            return (
              <button
                type="button"
                className={'side-action' + (blocked ? ' side-action--disabled' : '')}
                aria-disabled={blocked}
                onClick={() => { if (!blocked) useImageEditorStore.getState().openImageEditor(node.id); }}
                data-tip={gif
                  ? 'Can’t edit GIFs — editing would flatten the animation to a still image.'
                  : busy
                    ? 'Wait for the running generation to finish.'
                    : 'Crop, annotate and adjust this image (saved as a new version)'}
              >
                <span className="side-action-icon"><SquarePen size={15} /></span>
                Edit image
              </button>
            );
          })()}

          {v.media && (
            <button
              type="button"
              className="side-action"
              onClick={() => replaceMedia(node.id)}
              data-tip="Swap in a different photo or video (kept as a new version)"
            >
              <span className="side-action-icon"><ImagePlus size={15} /></span>
              Replace media
            </button>
          )}
        </div>
      </NodeSidePanelStack>
    );
  }

  return (
    <NodeSidePanelStack {...panelProps}>
      <div className="side-panel-content">
        <div className="versions-row">
          {/* F.2 — version cluster on the LEFT (kept tight as one
              unit), action triplet on the RIGHT (spread). The middle
              flex spacer is implicit via `justify-content:
              space-between` on .versions-row. */}
          <div className="versions-row-cluster">
            <button
              type="button"
              disabled={node.currentVersionIndex === 0}
              onClick={() => onSwitchVersion(-1)}
              data-tip="Previous version"
              aria-label="Previous version"
            >
              <ChevronLeft size={14} />
            </button>
            <VersionCounter current={node.currentVersionIndex + 1} total={node.versions.length} />
            <button
              type="button"
              disabled={node.currentVersionIndex >= node.versions.length - 1}
              onClick={() => onSwitchVersion(1)}
              data-tip="Next version"
              aria-label="Next version"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="versions-row-actions">
            <button
              type="button"
              disabled={!!node.generating || emptyText}
              onClick={() => void redoTermMarking(node.id)}
              data-tip="Re-mark the clickable terms in the current text (new version)"
              aria-label="Redo term marking"
            >
              <ListRestart size={14} />
            </button>
            <button
              type="button"
              onClick={() => void regenerateNode(node.id)}
              disabled={emptyText}
              data-tip="Regenerate from the current header and the parent node's context (new version)"
              aria-label="Regenerate"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              data-tip={node.generating ? 'Stop generation and delete current work' : 'Delete version (or whole node)'}
              aria-label="Delete"
            >
              <Trash size={14} />
            </button>
          </div>
        </div>

        <AddNodeMenu key={node.id} nodeId={node.id} />

        <button
          type="button"
          className={'side-action side-disclosure-trigger' + (openSection === 'text' ? ' toggled' : '')}
          onClick={() => toggleSection('text')}
          data-tip="Edit, expand, or extract this node's text"
          aria-expanded={openSection === 'text'}
          aria-controls={`node-text-tools-${node.id}`}
          aria-label="Edit"
        >
          <span className="side-action-icon"><FileText size={15} /></span>
          <span className="side-action-label">Edit</span>
          <span className="side-disclosure-chevron">
            {openSection === 'text' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </button>

        <AnimatedCollapse open={openSection === 'text'}><div id={`node-text-tools-${node.id}`} className="side-disclosure-content">
        <EditHeaderButton node={node} />
        <button
          type="button"
          className="side-action"
          onClick={() => openEditor(node.id)}
          disabled={emptyText}
        >
          <span className="side-action-icon"><FileText size={15} /></span>
          Edit or export text
        </button>
        {isExplain ? (
          <button
            type="button"
            className="side-action"
            onClick={() => void expandPart(node.id, { kind: 'freetext' })}
            disabled={expandSelectedDisabled}
            data-tip={wholeRunning || samePartialRunning
              ? 'This explanation is already being expanded'
              : 'Expand this explanation with more detail'}
          >
            <span className="side-action-icon"><ChevronsUpDown size={15} /></span>
            Expand
          </button>
        ) : <>
        {/* "Expand whole" — calls elaborateNode, which streams an
            extended version of the entire body. ListChevronsUpDown
            icon signals "many sections at once." */}
        <button
          type="button"
          className="side-action"
          onClick={() => void elaborateNode(node.id)}
          disabled={emptyText}
          data-tip="Extend the whole body with more detail"
        >
          <span className="side-action-icon"><ListChevronsUpDown size={15} /></span>
          Expand whole
        </button>

        {/* "Expand selected" — calls expandPart on the active
            section. ChevronsUpDown (plain) marks it as the
            single-section variant of Expand-whole. Target picked
            from bulletsCollapsed + activeIdx as documented in
            onExpandSelected. Disabled while a whole rewrite is in
            flight (no partials allowed) or while THIS section is
            already being expand-part'd. */}
        <button
          type="button"
          className="side-action"
          onClick={onExpandSelected}
          disabled={expandSelectedDisabled}
          aria-label={expandSelectedLabel}
          data-tip={
            wholeRunning
              ? 'Whole-body rewrite in progress'
              : samePartialRunning
                ? 'This section is already being expanded'
                : bulletsCollapsed || activeIdx === null
                  ? 'Expand the opening paragraph'
                  : `Expand the selected bullet (#${activeIdx + 1})`
          }
        >
          <span className="side-action-icon"><ChevronsUpDown size={15} /></span>
          {expandSelectedLabel}
        </button>

        {/* "Pop selected" — lifts the selected+expanded bullet (with its
            sub-points) out into a new child node, then the AI reworks it
            (opening paragraph + sub-points regrouped into ≥2 named groups).
            One undo press reverses the whole thing. */}
        <button
          type="button"
          className="side-action"
          onClick={onPopSelected}
          disabled={popDisabled}
          data-tip={
            wholeRunning
              ? 'Whole-body rewrite in progress'
              : popDisabled
                ? 'Select and expand a bullet to extract it'
                : `Extract the selected bullet (#${(activeIdx ?? 0) + 1}) into its own node`
          }
        >
          <span className="side-action-icon"><SquareArrowOutUpRight size={15} /></span>
          Extract bullet
        </button>
        </>}

        {node.type !== 'root' && <button
          type="button"
          className="side-action"
          disabled={!!node.generating || !!activeRecords?.length}
          onClick={() => { void retypeNodeToText(node.id, isExplain ? 'encyclopedic' : 'explain'); }}
          data-tip="Generate a new version in this format; keep the previous version"
        >
          <span className="side-action-icon"><ArrowRightLeft size={15} /></span>
          {isExplain ? 'Convert to encyclopedic node' : 'Convert to explain node'}
        </button>}

        </div></AnimatedCollapse>

        <AddToProjectSourcesButton version={v} disabled={!!node.generating} />

        <button
          type="button"
          className={'side-action side-disclosure-trigger' + (openSection === 'group' ? ' toggled' : '') + (isRoot ? ' side-action--disabled' : '')}
          onClick={() => { if (!isRoot) toggleSection('group'); }}
          aria-disabled={isRoot}
          aria-expanded={!isRoot && openSection === 'group'}
          aria-controls={`node-group-tools-${node.id}`}
          aria-label="Group"
          data-tip={isRoot
            ? 'Can’t group the starting node — group its children instead.'
            : 'Assign this node to a group, or create a new one'}
        >
          <span className="side-action-icon"><Palette size={15} /></span>
          <span className="side-action-label">Group</span>
          <span className="side-disclosure-chevron">
            {openSection === 'group' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </button>
        <AnimatedCollapse open={openSection === 'group' && !isRoot}>
          <div
            id={`node-group-tools-${node.id}`}
            className="side-disclosure-content side-disclosure-content--group"
          >
            <NodeGroupMenu
            nodeGroupId={node.groupId ?? null}
            branchHasGroupedDescendants={branchHasGroupedDescendants}
            groups={Object.values(project.groups)}
            onAssign={(gid) => assignNodeToGroup(node.id, gid)}
            onAssignSubtree={(gid) => assignSubtreeToGroup(node.id, gid)}
            onNewFromNode={(spread) => { createGroupFromNode(node.id, spread); }}
            />
          </div>
        </AnimatedCollapse>

        {hasFactCheck && (
          <>
            <button
              type="button"
              className={'side-action side-disclosure-trigger' + (openSection === 'fact' ? ' toggled' : '')}
              onClick={() => {
                if (factPanelOpen) {
                  useCitationPanelStore.getState().close();
                  setOpenSection(null);
                  return;
                }
                setOpenSection('fact');
                showFactResults();
              }}
              data-tip={`${factPanelOpen ? 'Hide' : 'Show'} this version’s evidence review`}
              aria-label={`${factPanelOpen ? 'Hide' : 'Show'} fact-check results`}
              aria-expanded={openSection === 'fact'}
              aria-controls={`node-fact-tools-${node.id}`}
            >
              <span className="side-action-icon"><SearchCheck size={15} /></span>
              <span className="side-action-label">{factPanelOpen ? 'Hide fact-check results' : 'Show fact-check results'}</span>
              <span className="side-disclosure-chevron">
                {openSection === 'fact' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </button>
            <AnimatedCollapse open={openSection === 'fact'}>
              <div id={`node-fact-tools-${node.id}`} className="side-disclosure-content">
                <button
                  type="button"
                  className="side-action"
                  onClick={() => {
                    if (factTaskRunning) stopFactCheck(node.id, v.createdAt);
                    else beginFactCheck(factIncomplete ? 'continue' : 'again');
                  }}
                  data-tip={factTaskRunning
                    ? 'Stop new requests and keep every completed result'
                    : factIncomplete
                      ? 'Retry only unfinished passages'
                      : 'Run a fresh evidence check while retaining these results'}
                >
                  <span className="side-action-icon">
                    {factTaskRunning ? <Square size={15} /> : <CheckCheck size={15} />}
                  </span>
                  {factTaskRunning
                    ? 'Stop checking'
                    : factIncomplete
                      ? 'Continue check'
                      : 'Check again'}
                </button>
                <button
                  type="button"
                  className={'side-action' + (
                    factTaskRunning || factIncomplete || !factState?.complete
                      ? ' side-action--disabled'
                      : ''
                  )}
                  aria-disabled={factTaskRunning || factIncomplete || !factState?.complete}
                  onClick={() => {
                    if (!factTaskRunning && !factIncomplete && factState?.complete) {
                      void rewriteNodeWithEvidence(node.id, factState.complete);
                    }
                  }}
                  data-tip="Create a corrected new version using this evidence without searching again"
                >
                  <span className="side-action-icon"><SpellCheck size={15} /></span>
                  Rewrite with evidence
                </button>
              </div>
            </AnimatedCollapse>
          </>
        )}

        <button
          type="button"
          className={'side-action side-disclosure-trigger' + (openSection === 'wikimedia' ? ' toggled' : '') + (imageDisclosureDisabled ? ' side-action--disabled' : '')}
          aria-disabled={imageDisclosureDisabled}
          aria-expanded={openSection === 'wikimedia'}
          aria-controls={`node-wikimedia-tools-${node.id}`}
          onClick={() => {
            if (wikimediaPanelOpen) {
              useCitationPanelStore.getState().close();
              setOpenSection(null);
              return;
            }
            if (imageDisclosureDisabled) return;
            setOpenSection('wikimedia');
            useCitationPanelStore.getState().openWikimedia(node.id, v.createdAt);
          }}
          data-tip={imageRecommendationSet
            ? 'Show the freely reusable images saved for this version'
            : (displayedVersionGenerating
              ? 'Wait until this version has finished generating'
              : 'Search image catalogs directly; no AI requests')}
        >
          <span className={'side-action-icon' + (wikimediaTask?.running ? ' is-spinning' : '')}>
            {wikimediaTask?.running ? <LoaderCircle size={15} /> : <Images size={15} />}
          </span>
          <span className="side-action-label">{wikimediaPanelOpen ? 'Hide free images' : (!autoFreeImages || !versionSupportsAutomaticFreeImages(node, v)) && !imageRecommendationSet && !wikimediaTask ? 'Search for free images' : 'Show free images'}</span>
          {!wikimediaTask?.running && imageRecommendationSet ? <span className="side-action-count">{imageRecommendationSet.results.length}</span> : null}
          <span className="side-disclosure-chevron">
            {openSection === 'wikimedia' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </button>
        <AnimatedCollapse open={openSection === 'wikimedia'}>
          <div id={`node-wikimedia-tools-${node.id}`} className="side-disclosure-content">
            <button
              type="button"
              className={'side-action' + (imageRedoDisabled ? ' side-action--disabled' : '')}
              aria-disabled={imageRedoDisabled}
              onClick={() => {
                if (!imageRedoDisabled) {
                  useCitationPanelStore.getState().openWikimedia(node.id, v.createdAt);
                  void startWikimediaDiscovery(node.id, v.createdAt, { rerun: true });
                }
              }}
              data-tip={wikimediaTask?.running
                ? 'A fresh image search is already running'
                : (displayedVersionGenerating
                    ? 'Wait until this version has finished generating before searching again'
                    : !v.body.trim() ? 'Add text before running an AI image search'
                      : imageSearchAvailable.reason ?? 'Redo the AI-assisted image search for this node')}
            >
              <span className={'side-action-icon' + (wikimediaTask?.running ? ' is-spinning' : '')}>
                {wikimediaTask?.running ? <LoaderCircle size={15} /> : <RotateCcw size={15} />}
              </span>
              {wikimediaTask?.running ? 'Searching…' : 'Redo agentic search'}
            </button>
          </div>
        </AnimatedCollapse>

        {isExplain && (
          <button
            type="button"
            className={'side-action' + (
              emptyText || node.generating || !interactiveGenerationAvailable
                ? ' side-action--disabled'
                : ''
            )}
            aria-disabled={emptyText || !!node.generating || !interactiveGenerationAvailable}
            onClick={() => {
              if (emptyText || node.generating) return;
              if (interactiveGenerationAvailable) spawnInteractiveNode(node.id, true);
            }}
            data-tip={(interactiveGenerationAvailable
                ? 'Create an interactive node from this explanation'
                : 'Choose an interactive model in Settings') + '. Higher costs compared to the text or image nodes.'}
          >
            <span className="side-action-icon">
              <Sparkles size={15} />
            </span>
            Generate interactive explanation
            <span className="interactive-cost-icons" aria-hidden="true"><TriangleAlert size={13} /><DollarSign size={13} /></span>
          </button>
        )}

        {!hasFactCheck && (
          <button
            type="button"
            className={'side-action' + (
              emptyText || !factAvailable.available || displayedVersionGenerating
                ? ' side-action--disabled'
                : ''
            )}
            aria-disabled={emptyText || !factAvailable.available || displayedVersionGenerating}
            onClick={() => {
              if (!emptyText && factAvailable.available && !displayedVersionGenerating) beginFactCheck('new');
            }}
            data-tip={displayedVersionGenerating
              ? 'Wait until this displayed version finishes generating.'
              : factAvailable.reason ?? 'Search the web for evidence about every factual passage'}
          >
            <span className="side-action-icon"><Check size={15} /></span>
            Fact-check
          </button>
        )}

        {!isRoot && (
          <button
            type="button"
            className={'side-action' + (
              branchHasGeneratingNode || creatingBranchProject
                ? ' side-action--disabled'
                : ''
            )}
            aria-disabled={branchHasGeneratingNode || creatingBranchProject}
            onClick={() => {
              if (branchHasGeneratingNode || creatingBranchProject) return;
              setCreatingBranchProject(true);
              setBranchProjectError(null);
              void createScatterFromBranch(node.id)
                .catch((error) => {
                  console.error('[scatter] could not create project from branch', error);
                  setBranchProjectError(
                    error instanceof Error ? error.message : 'Could not create the project.',
                  );
                })
                .finally(() => setCreatingBranchProject(false));
            }}
            data-tip={branchProjectError ?? (branchHasGeneratingNode
              ? 'Wait for every node in this branch to finish generating.'
              : creatingBranchProject
                ? 'Copying this branch into a new project…'
                : 'Copy this node and its branch into a new project')}
          >
            <span className={'side-action-icon' + (creatingBranchProject ? ' is-spinning' : '')}>
              {creatingBranchProject ? <LoaderCircle size={15} /> : <FileSymlink size={15} />}
            </span>
            Create project from branch
          </button>
        )}

      </div>
    </NodeSidePanelStack>
  );
}
