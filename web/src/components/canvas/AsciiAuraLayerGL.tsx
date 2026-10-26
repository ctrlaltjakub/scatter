'use client';
import { generatingTitleDotVisible, isImageTitlePending } from '@/lib/imageQuestionTitle';
/**
 * Scatter — interactive-background layer, WebGL2 renderer.
 *
 * ⚠ ARCHITECTURE — READ FIRST: this is the ONE AND ONLY interactive-background
 * renderer. Scatter once also had a canvas-2D CPU renderer; it was REMOVED ON
 * PURPOSE (slow + buggy). Comments below (and in lib/asciiAura/*) that mention
 * "the 2D path" / "2D parity" / "the 2D renderer" describe that original CPU
 * implementation as HISTORY — they explain WHY a given choice was made, NOT a
 * live sibling to keep in sync with. Do not re-add a 2D renderer. When WebGL2 is
 * unavailable the chooser (AsciiAuraLayer.tsx) shows a skippable notice instead —
 * there is no rendering fallback.
 *
 * Two GPU passes (see lib/asciiAura/gl/shaders.ts) replace what used to be a CPU
 * per-cell loop. Per frame the CPU only:
 *   - packs the aura/ghost records into a Float32Array (≤ a few
 *     hundred entries), uploads one tiny texture, and
 *   - issues two draw calls.
 * The diff cache / stability gate / pattern tile / 20 fps throttle that the old
 * CPU renderer needed are simply unnecessary here: the GPU recomputes every cell
 * every frame in well under a millisecond, so pan, waves, tweens and cooling all
 * run at display refresh rate.
 *
 * Properties (originally framed as improvements over that CPU renderer):
 *   - Native-DPR rendering: cells/glyphs rasterize at device
 *     resolution (crisp on HiDPI; identical at dpr 1).
 *   - Animations at refresh rate instead of 20 fps.
 *
 * Idle behavior: rendering stops COOL_TAIL_MS after the last dirty
 * signal / active animation (covers the longest possible cooling
 * trail — the old CPU renderer instead did a CPU-side hasCoolingCells readback,
 * which a GPU pipeline can't do without stalling).
 */
import { useEffect, useRef, type RefObject } from 'react';
import {
  createAuraSceneState,
  type AuraSceneFactory,
  type AuraScene,
} from '@/lib/asciiAura/sceneState';
import {
  clearAuraTintCache,
  resolveAuraTintNumeric,
  type AuraTintFallback,
} from '@/lib/asciiAura/auraTint';
import { THEME_CHANGE_EVENT } from '@/lib/theme';
import { registerScreenshotRenderer } from '@/lib/screenshotRenderers';
import {
  packRecords,
  FLOATS_PER_RECORD,
  MAX_RECORDS,
} from '@/lib/asciiAura/gl/recordPacking';
import { COOL_STAGES_PER_SEC } from '@/lib/asciiAura/gl/coolingEncode';
import { buildBaselinePaletteVec4, MAX_PALETTE } from '@/lib/asciiAura/gl/paletteGL';
import { buildAtlasCanvas } from '@/lib/asciiAura/gl/atlas';
import {
  VERTEX_SRC,
  PASS_A_FRAGMENT_SRC,
  PASS_B_FRAGMENT_SRC,
  MAX_STATUS_COLORS,
} from '@/lib/asciiAura/gl/shaders';
import {
  layoutStatusProcesses,
  statusFullyDeleted,
  isCharShown,
  renderableCount,
  STATUS_REVEAL_MS_PER_CHAR,
  STATUS_DELETE_MS_PER_CHAR,
} from '@/lib/asciiAura/statusText';
import { paintArrowDimming } from '@/lib/asciiAura/arrowDim';
import {
  computeArrowLabels,
  nodeArrowLabelHeader,
  type AuraOwner,
  type ArrowLabelDebug,
  type Segment,
} from '@/lib/asciiAura/arrowLabels';
import {
  computeGroupClusters,
  computeGroupLabels,
  projectUngroupedClusterKey,
  groupLabelMode,
  type GroupClusterNode,
} from '@/lib/asciiAura/groupLabels';
import { layoutDragHint } from '@/lib/asciiAura/dragHint';
import { layoutProjectSyncLabel } from '@/lib/asciiAura/projectSyncLabel';
import {
  reconcileDragHintPresentationFrame,
  subscribeDragHintRendererInvalidation,
} from '@/lib/asciiAura/dragHintRuntime';
import {
  placeArrowOverlayGlyph,
  placeBorrowedOverlayGlyph,
  placeGroupOverlayGlyph,
  placeProjectColorOverlayGlyph,
} from '@/lib/asciiAura/gl/overlay';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useDragHintStore } from '@/store/useDragHintStore';
import {
  useDragHintPresentationStore,
  type DesiredDragHintPresentation,
} from '@/store/useDragHintPresentationStore';
import { useArrowAnchorsStore } from '@/store/useArrowAnchorsStore';
import { useArrowLabelStore, type DesiredLabel } from '@/store/useArrowLabelStore';
import { isArrowVisible } from '@/lib/arrowPolicy';
import { useGroupLabelStore, type DesiredGroupLabel } from '@/store/useGroupLabelStore';
import { useProjectSyncLabelStore } from '@/store/useProjectSyncLabelStore';
import { useCanvasSelectionStore } from '@/store/useCanvasSelectionStore';
import { AURA_RADIUS_FOCUSED } from '@/lib/asciiAura/sceneState';
import { paintSelectionOverlay, selectionAuraBorder } from '@/lib/asciiAura/selectionOverlay';
import { useGraphStore } from '@/store/useGraphStore';
import { isBatchNodeSelection } from '@/lib/nodeSelection';
import {
  bboxFullyVisible,
  bboxIntersectsViewport,
  currentSidebarInsetPx,
  type BBox,
} from '@/lib/nodeVisibility';

const SCREEN_CELL_PX = 9; // CSS px — nominal grid pitch (see CELL note in buildOverlay)
const SCREEN_FONT_PX = 8;
/** Part F — "negative aura": gently thin the field within this many cells of
 *  the status text. Kept small/soft now that status glyphs blend into the field
 *  (same colour + opacity) rather than overpainting it. Tune RADIUS (reach) and
 *  MAX_STAGES (depth) together; 0/0 removes the halo entirely. */
const STATUS_HALO_RADIUS_CELLS = 4;
const STATUS_HALO_MAX_STAGES = 10;
/** Shape-only labels already sit beside an arrow's own 22px clearing band, so
 * retain their established softer halo while status text gets the stronger
 * standalone treatment above. */
const LABEL_HALO_RADIUS_CELLS = 3;
const LABEL_HALO_MAX_STAGES = 8;
/** Keep rendering this long after the last activity so cooling
 *  trails (8 stages ÷ 20 st/s = 400 ms) finish before idling. */
const COOL_TAIL_MS = 450;

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  sceneFactory?: AuraSceneFactory;
  renderAppOverlays?: boolean;
}

interface GLState {
  gl: WebGL2RenderingContext;
  progA: WebGLProgram;
  progB: WebGLProgram;
  vao: WebGLVertexArrayObject;
  recordsTex: WebGLTexture;
  atlasTex: WebGLTexture;
  /** RG8 per-cell overlay: R = status glyph index, G = arrow-dim factor. */
  overlayTex: WebGLTexture;
  stateTexA: WebGLTexture;
  stateTexB: WebGLTexture;
  fboA: WebGLFramebuffer;
  fboB: WebGLFramebuffer;
  /** true → next pass A READS B and WRITES A. */
  writeA: boolean;
  // Uniform locations (pass A)
  aRecords: WebGLUniformLocation | null;
  aPrevState: WebGLUniformLocation | null;
  aRecordCount: WebGLUniformLocation | null;
  aViewport: WebGLUniformLocation | null;
  aCellCssPx: WebGLUniformLocation | null;
  aDtMs: WebGLUniformLocation | null;
  aCoolRate: WebGLUniformLocation | null;
  aResetHistory: WebGLUniformLocation | null;
  // Uniform locations (pass B)
  bCellState: WebGLUniformLocation | null;
  bRecords: WebGLUniformLocation | null;
  bAtlas: WebGLUniformLocation | null;
  bPalette: WebGLUniformLocation | null;
  bPaletteCount: WebGLUniformLocation | null;
  bNeutral: WebGLUniformLocation | null;
  bAlphaBoost: WebGLUniformLocation | null;
  bDeviceCellPx: WebGLUniformLocation | null;
  bCellCssPx: WebGLUniformLocation | null;
  bViewport: WebGLUniformLocation | null;
  bCanvasHpx: WebGLUniformLocation | null;
  bCellsMax: WebGLUniformLocation | null;
  bOverlay: WebGLUniformLocation | null;
  bStatusColors: WebGLUniformLocation | null;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.error('[asciiAura GL] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    // eslint-disable-next-line no-console
    console.error('[asciiAura GL] program link failed:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function makeStateTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export function AsciiAuraLayerGL({
  containerRef,
  sceneFactory,
  renderAppOverlays = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stateRef = useRef({
    fontReady: false,
    baselineColor: 'rgba(195,195,195,0.6)', // default matches --scatter-base; used until the CSS var is read
    auraColor: 'rgba(195,195,195,1)',       // default matches --aura-color
    alphaBoost: 0.05,
    /** Part F/G — CPU-side per-cell overlay buffer (RGBA8, row-major):
     *  R = status glyph index, G = arrow demote, B = status colour index.
     *  Zero-filled each frame (G=0 → no demote, R=0 → no status). */
    overlayData: new Uint8Array(0),
    /** Grid size the overlay texture+buffer were last allocated for. */
    overlayKey: '',
    /** Part F — per-frame status-colour palette (rgba floats) indexed by the
     *  overlay's B channel; one entry per distinct generating-node accent. */
    statusColorData: new Float32Array(MAX_STATUS_COLORS * 4),
    statusColorCount: 0,
    containerW: 0,
    containerH: 0,
    dirty: true,
    resetHistory: true,
    lastActivity: 0,
    lastPassATime: 0,
    lastZoom: 1,
    // Sizing snapshot — drives texture/canvas reallocation.
    dpr: 0,
    deviceCellPx: 0,
    deviceFontPx: 0,
    deviceW: 0,
    deviceH: 0,
    cellsX: 0,
    cellsY: 0,
    atlasBuiltForCellPx: 0,
    // Palette cache — rebuilt when sceneState bumps paletteVersion
    // or the theme colors load.
    paletteVersion: -1,
    paletteData: new Float32Array(MAX_PALETTE * 4) as Float32Array<ArrayBufferLike>,
    paletteCount: 0,
    // Record staging buffer (uploaded via texSubImage2D each frame).
    records: new Float32Array(MAX_RECORDS * FLOATS_PER_RECORD),
    // Dev instrumentation.
    frames: 0,
    emaCpuMs: 0,
    worstCpuMs: 0,
  });

  const sceneRef = useRef<AuraScene | null>(null);
  if (sceneRef.current === null) {
    const sceneOptions = {
      onDirty: (reason) => {
        const s = stateRef.current;
        s.dirty = true;
        // Zoom invalidates the cooling history: the world content
        // under every screen cell changes abruptly (the old CPU renderer
        // did a full canvas refresh on zoom for the same reason).
        if (reason === 'zoom') s.resetHistory = true;
      },
    } satisfies Parameters<AuraSceneFactory>[0];
    sceneRef.current = sceneFactory
      ? sceneFactory(sceneOptions)
      : createAuraSceneState(sceneOptions);
  }
  const scene = sceneRef.current;

  const glRef = useRef<GLState | null>(null);

  useEffect(() => scene.subscribeStores(), [scene]);

  // Theme colors + pixel font.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let disposed = false;
    const synchronizeTheme = () => {
      clearAuraTintCache();
      const cs = getComputedStyle(document.documentElement);
      const baseline = cs.getPropertyValue('--scatter-base').trim();
      const aura = cs.getPropertyValue('--aura-color').trim();
      const s = stateRef.current;
      if (baseline) s.baselineColor = baseline;
      if (aura) s.auraColor = aura;
      s.alphaBoost = Math.min(1, Math.max(0, Number(cs.getPropertyValue('--ascii-alpha-boost')) || 0));
      s.paletteVersion = -1;
      s.resetHistory = true;
      s.dirty = true;
    };
    synchronizeTheme();
    window.addEventListener(THEME_CHANGE_EVENT, synchronizeTheme);
    const markFontReady = () => {
      if (disposed) return;
      const s = stateRef.current;
      s.fontReady = true;
      s.atlasBuiltForCellPx = 0; // (re)build atlas with the real (or fallback) font
      s.paletteVersion = -1;     // re-resolve colors
      s.dirty = true;
    };
    // The pixel font is an enhancement, not a hard requirement: if it fails to
    // load (e.g. the woff2 404s) STILL proceed, so the aura renders with the
    // monospace fallback instead of staying blank forever (and so the rejected
    // promise never surfaces as an unhandled "network error").
    document.fonts.load(`${SCREEN_FONT_PX}px "Press Start 2P"`).then(markFontReady, markFontReady);
    return () => {
      disposed = true;
      window.removeEventListener(THEME_CHANGE_EVENT, synchronizeTheme);
    };
  }, []);

  // Container sizing.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const s = stateRef.current;
      s.containerW = container.clientWidth;
      s.containerH = container.clientHeight;
      s.dirty = true;
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef]);

  // GL lifecycle + render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let capturePixelRatio: number | undefined;

    const initGL = (): GLState | null => {
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
      });
      if (!gl) return null;
      const progA = link(gl, VERTEX_SRC, PASS_A_FRAGMENT_SRC);
      const progB = link(gl, VERTEX_SRC, PASS_B_FRAGMENT_SRC);
      const vao = gl.createVertexArray();
      if (!progA || !progB || !vao) return null;

      // Records data texture: MAX_RECORDS × 4 RGBA32F texels, row 0.
      const recordsTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, recordsTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA32F,
        MAX_RECORDS * 4, 1, 0, gl.RGBA, gl.FLOAT, null,
      );

      const atlasTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Part F/G — per-cell RG8 overlay (status glyph + arrow dim). RG8
      // rows are 2·cellsX bytes, not 4-byte aligned → unpack alignment 1
      // (set once; harmless for the other, already-aligned, uploads).
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const overlayTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, overlayTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const stateTexA = makeStateTexture(gl);
      const stateTexB = makeStateTexture(gl);
      const fboA = gl.createFramebuffer()!;
      const fboB = gl.createFramebuffer()!;

      const u = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);
      return {
        gl, progA, progB, vao,
        recordsTex, atlasTex, overlayTex, stateTexA, stateTexB, fboA, fboB,
        writeA: true,
        aRecords: u(progA, 'uRecords'),
        aPrevState: u(progA, 'uPrevState'),
        aRecordCount: u(progA, 'uRecordCount'),
        aViewport: u(progA, 'uViewport'),
        aCellCssPx: u(progA, 'uCellCssPx'),
        aDtMs: u(progA, 'uDtMs'),
        aCoolRate: u(progA, 'uCoolRate'),
        aResetHistory: u(progA, 'uResetHistory'),
        bCellState: u(progB, 'uCellState'),
        bRecords: u(progB, 'uRecords'),
        bAtlas: u(progB, 'uAtlas'),
        bPalette: u(progB, 'uPalette[0]'),
        bPaletteCount: u(progB, 'uPaletteCount'),
        bNeutral: u(progB, 'uNeutral'),
        bAlphaBoost: u(progB, 'uAlphaBoost'),
        bDeviceCellPx: u(progB, 'uDeviceCellPx'),
        bCellCssPx: u(progB, 'uCellCssPx'),
        bViewport: u(progB, 'uViewport'),
        bCanvasHpx: u(progB, 'uCanvasHpx'),
        bCellsMax: u(progB, 'uCellsMax'),
        bOverlay: u(progB, 'uOverlay'),
        bStatusColors: u(progB, 'uStatusColors[0]'),
      };
    };

    glRef.current = initGL();
    if (!glRef.current) {
      // eslint-disable-next-line no-console
      console.error('[asciiAura GL] init failed — interactive background disabled');
    }
    stateRef.current.lastActivity = performance.now();

    const onLost = (e: Event) => {
      e.preventDefault();
      glRef.current = null;
    };
    const onRestored = () => {
      glRef.current = initGL();
      const s = stateRef.current;
      s.resetHistory = true;
      s.atlasBuiltForCellPx = 0;
      s.deviceW = 0; // force size/texture realloc
      s.overlayKey = ''; // the restored overlayTex has no storage yet
      s.dirty = true;
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    const unsubscribeDragHint = subscribeDragHintRendererInvalidation(() => {
      stateRef.current.dirty = true;
    });
    const unsubscribeProjectSyncLabel = useProjectSyncLabelStore.subscribe(() => {
      stateRef.current.dirty = true;
    });
    const unsubscribeSelection = useCanvasSelectionStore.subscribe(() => {
      stateRef.current.dirty = true;
    });

    /** (Re)allocate sizing-dependent resources when the container,
     *  dpr, or cell grid changed. Returns false when not renderable. */
    const ensureSized = (): boolean => {
      const s = stateRef.current;
      const g = glRef.current;
      if (!g || s.containerW === 0 || s.containerH === 0) return false;
      const { gl } = g;

      const dpr = capturePixelRatio ?? Math.max(1, window.devicePixelRatio || 1);
      const deviceCellPx = Math.max(1, Math.round(SCREEN_CELL_PX * dpr));
      const deviceW = Math.round(s.containerW * dpr);
      const deviceH = Math.round(s.containerH * dpr);

      if (dpr !== s.dpr) {
        s.dpr = dpr;
        s.deviceCellPx = deviceCellPx;
        s.deviceFontPx = Math.max(1, Math.round(SCREEN_FONT_PX * dpr));
        s.atlasBuiltForCellPx = 0;
        s.resetHistory = true;
      }

      if (deviceW !== s.deviceW || deviceH !== s.deviceH) {
        s.deviceW = deviceW;
        s.deviceH = deviceH;
        canvas.width = deviceW;
        canvas.height = deviceH;
        canvas.style.width = `${s.containerW}px`;
        canvas.style.height = `${s.containerH}px`;
        const cellsX = Math.ceil(deviceW / s.deviceCellPx);
        const cellsY = Math.ceil(deviceH / s.deviceCellPx);
        if (cellsX !== s.cellsX || cellsY !== s.cellsY) {
          s.cellsX = cellsX;
          s.cellsY = cellsY;
          for (const [tex, fbo] of [[g.stateTexA, g.fboA], [g.stateTexB, g.fboB]] as const) {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(
              gl.TEXTURE_2D, 0, gl.RGBA8,
              cellsX, cellsY, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
            );
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          s.resetHistory = true;
        }
      }

      // Part F/G — (re)allocate the RG8 overlay texture + CPU buffers
      // whenever the cell grid changes (or after a context restore, which
      // resets overlayKey). Kept outside the size-change block above so a
      // restored-but-same-size context still gets its fresh texture sized.
      const overlayKey = `${s.cellsX}x${s.cellsY}`;
      if (s.overlayKey !== overlayKey && s.cellsX > 0 && s.cellsY > 0) {
        s.overlayKey = overlayKey;
        gl.bindTexture(gl.TEXTURE_2D, g.overlayTex);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA8,
          s.cellsX, s.cellsY, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
        );
        s.overlayData = new Uint8Array(s.cellsX * s.cellsY * 4);
      }

      if (s.atlasBuiltForCellPx !== s.deviceCellPx && s.fontReady) {
        const built = buildAtlasCanvas(s.deviceCellPx, s.deviceFontPx);
        if (built) {
          gl.bindTexture(gl.TEXTURE_2D, g.atlasTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, built.canvas);
          s.atlasBuiltForCellPx = s.deviceCellPx;
        }
      }
      return s.atlasBuiltForCellPx === s.deviceCellPx;
    };

    /** Cheap poll: is any status still on-screen (animating in/out)? Drives
     *  the loop's wake gate so rendering continues through a generation even
     *  when nothing else (wave/ghost/tween) is animating. */
    const statusAwake = (now: number): boolean => {
      const state = useNodeStatusStore.getState();
      const statuses = state.statuses;
      for (const id in statuses) {
        const e = statuses[id]!;
        if (!statusFullyDeleted(e.text, e.clearedAt, now)) return true;
      }
      for (const nodeId in state.processes) {
        for (const processId in state.processes[nodeId]) {
          const entry = state.processes[nodeId]![processId]!;
          if (!statusFullyDeleted(entry.text, entry.clearedAt, now)) return true;
        }
      }
      return false;
    };

    /** Keep the loop awake while any ASCII label is still typing on or wiping
     *  off — otherwise an animation would freeze once the camera/physics settle. */
    const labelAwake = (now: number): boolean => {
      for (const entries of [
        useArrowLabelStore.getState().entries,
        useGroupLabelStore.getState().entries,
      ]) {
        for (const id in entries) {
          const e = entries[id]!;
          const total = e.cells.length;
          if (e.clearedAt == null) {
            if ('targetNodeId' in e && isImageTitlePending(useGraphStore.getState().project?.nodes[e.targetNodeId])) return true;
            if (now - e.startedAt < total * STATUS_REVEAL_MS_PER_CHAR) return true;
          } else if (now - e.clearedAt < total * STATUS_DELETE_MS_PER_CHAR + 60) {
            return true;
          }
        }
      }
      for (const entry of Object.values(useProjectSyncLabelStore.getState().entries)) {
        const total = renderableCount(entry.text);
        if (entry.clearedAt == null) {
          if (now - entry.startedAt < total * STATUS_REVEAL_MS_PER_CHAR) return true;
        } else if (now - entry.clearedAt < total * STATUS_DELETE_MS_PER_CHAR + 60) {
          return true;
        }
      }
      return false;
    };

    const dragHintAwake = (now: number): boolean => {
      const entry = useDragHintPresentationStore.getState().entry;
      if (!entry) return false;
      const total = entry.layout.cells.length;
      return entry.clearedAt == null
        ? now - entry.startedAt < total * STATUS_REVEAL_MS_PER_CHAR
        : !statusFullyDeleted(entry.text, entry.clearedAt, now);
    };

    // Placement is substantially more expensive than painting already-laid
    // out glyphs. Status/type-on animations can keep this render loop awake
    // for hundreds of frames while geometry is unchanged, so cache the pure
    // placement result behind a compact geometry/text signature.
    let labelPlacementCacheKey = '';
    let cachedArrowPlacements: ReturnType<typeof computeArrowLabels> = [];
    let cachedGroupPlacements: ReturnType<typeof computeGroupLabels> = [];
    let selectionBorderKey = '';
    let cachedSelectionBorder: ReturnType<typeof selectionAuraBorder> = [];

    /** Part F/G — fill the CPU overlay buffer for this frame: status letters
     *  above each generating node (R = atlas glyph, B = group-colour index)
     *  and a fade band under every arrow (G = stage-demote amount). Also fills
     *  the per-frame status-colour palette. Prunes finished-delete statuses. */
    const buildOverlay = (
      now: number,
      resolveTint: (accent: Parameters<typeof resolveAuraTintNumeric>[0]) => ReturnType<typeof resolveAuraTintNumeric>,
    ) => {
      const s = stateRef.current;
      if (!renderAppOverlays) {
        s.overlayData.fill(0);
        s.statusColorCount = 0;
        return;
      }
      const sc = scene.state;
      const cellsX = s.cellsX;
      const cellsY = s.cellsY;
      const data = s.overlayData;
      data.fill(0); // R=0 (no status), G=0 (no demote), B=0
      const v = sc.viewport;
      // TRUE CSS cell pitch — must match pass A's uCellCssPx (deviceCellPx/dpr),
      // NOT the nominal 9: at fractional display scaling deviceCellPx ≠ 9·dpr, so
      // a hard 9 drifts the overlay cells off the rendered grid (the upward arrow
      // misalignment). deviceCellPx/dpr maps a CSS screen point to the same cell
      // the shader draws.
      const CELL = s.deviceCellPx / s.dpr;
      const screenW = s.deviceW / s.dpr;
      const screenH = s.deviceH / s.dpr;
      const sidebarInsetPx = currentSidebarInsetPx();

      // ── Status text → R (glyph) + B (group-colour index). ──
      const colorData = s.statusColorData;
      const colorIndexByAccent = new Map<string, number>();
      let colorCount = 0;
      const colorIndexForAccent = (accent: string | null): number => {
        const accentKey = accent ?? '__none__';
        const existing = colorIndexByAccent.get(accentKey);
        if (existing !== undefined) return existing;
        if (colorCount >= MAX_STATUS_COLORS) return 0;
        const tint = resolveTint(accent);
        const colorIdx = colorCount++;
        colorData[colorIdx * 4] = tint.r;
        colorData[colorIdx * 4 + 1] = tint.g;
        colorData[colorIdx * 4 + 2] = tint.b;
        colorData[colorIdx * 4 + 3] = tint.alphaFocus;
        colorIndexByAccent.set(accentKey, colorIdx);
        return colorIdx;
      };
      // Screen rects (CSS px) the arrow labels must avoid: status text boxes
      // (collected below) + node cards (added in the label block).
      const statusBoxes: { x: number; y: number; w: number; h: number }[] = [];
      const protectedLabelCellIndices = new Set<number>();
      const statusState = useNodeStatusStore.getState();
      const statuses = statusState.statuses;
      const processStatuses = statusState.processes;
      const statusNodeIds = new Set([...Object.keys(statuses), ...Object.keys(processStatuses)]);
      for (const nodeId of statusNodeIds) {
        const entries = [];
        const primary = statuses[nodeId];
        if (primary) {
          if (statusFullyDeleted(primary.text, primary.clearedAt, now)) {
            statusState.removeStatus(nodeId);
          } else entries.push(primary);
        }
        for (const processId in processStatuses[nodeId]) {
          const entry = processStatuses[nodeId]![processId]!;
          if (statusFullyDeleted(entry.text, entry.clearedAt, now)) {
            statusState.removeProcessStatus(nodeId, processId);
          } else entries.push(entry);
        }
        if (entries.length === 0) continue;
        const aura = sc.auras.get(nodeId);
        if (!aura) continue; // node not in the current scene (e.g. bg project)
        // This node's status colour = its group accent at the focused tier
        // (matches the aura glyphs). Deduped so nodes sharing an accent share
        // a palette slot.
        const colorIdx = colorIndexForAccent(aura.accent);
        const node = {
          x: aura.rect.x * v.zoom + v.x,
          y: aura.rect.y * v.zoom + v.y,
          w: aura.rect.w * v.zoom,
          h: aura.rect.h * v.zoom,
        };
        const cells = layoutStatusProcesses({
          processes: entries, node, cellPx: CELL,
          cols: cellsX, rows: cellsY, now,
        });
        for (const c of cells) {
          const cellIndex = c.row * cellsX + c.col;
          const base = cellIndex * 4;
          data[base] = c.glyphIndex; // R
          data[base + 2] = colorIdx; // B
          protectedLabelCellIndices.add(cellIndex);
        }
        // Remember this status's footprint so labels don't land on it.
        if (cells.length > 0) {
          let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
          for (const c of cells) {
            if (c.col < minC) minC = c.col;
            if (c.col > maxC) maxC = c.col;
            if (c.row < minR) minR = c.row;
            if (c.row > maxR) maxR = c.row;
          }
          statusBoxes.push({ x: minC * CELL, y: minR * CELL, w: (maxC - minC + 1) * CELL, h: (maxR - minR + 1) * CELL });
        }
        // Negative aura: thin the field within STATUS_HALO_RADIUS_CELLS of the
        // text (demote G, gradient: strongest next to the letters). The status
        // cells themselves keep their glyph — the shader ignores demote where a
        // status glyph is set.
        const HR = STATUS_HALO_RADIUS_CELLS;
        for (const c of cells) {
          for (let dr = -HR; dr <= HR; dr++) {
            const row = c.row + dr;
            if (row < 0 || row >= cellsY) continue;
            for (let dc = -HR; dc <= HR; dc++) {
              const col = c.col + dc;
              if (col < 0 || col >= cellsX) continue;
              const dist = Math.sqrt(dc * dc + dr * dr);
              if (dist > HR) continue;
              const dem = Math.round(STATUS_HALO_MAX_STAGES * (1 - dist / HR));
              if (dem <= 0) continue;
              const gByte = (row * cellsX + col) * 4 + 1;
              if (dem > data[gByte]!) data[gByte] = dem;
            }
          }
        }
      }
      // ── Drag gesture hint beside the node's top-right pin button. ──
      // It uses the same atlas, animation, borrowed aura appearance, and
      // negative-aura treatment as arrow labels, but is not hit-testable.
      const dragHint = useDragHintStore.getState().hint;
      let desiredDragHint: DesiredDragHintPresentation | null = null;
      if (dragHint && dragHint.clearedAt == null) {
        const aura = sc.auras.get(dragHint.nodeId);
        if (aura) {
          const blockedRects = [...sc.auras.values()]
            .filter((other) => other.id !== dragHint.nodeId)
            .map((other) => ({
              x: other.rect.x * v.zoom + v.x,
              y: other.rect.y * v.zoom + v.y,
              w: other.rect.w * v.zoom,
              h: other.rect.h * v.zoom,
            }));
          const layout = layoutDragHint({
            text: dragHint.text,
            node: {
              x: aura.rect.x * v.zoom + v.x,
              y: aura.rect.y * v.zoom + v.y,
              w: aura.rect.w * v.zoom,
              h: aura.rect.h * v.zoom,
            },
            blockedRects,
            cellPx: CELL,
            cols: cellsX,
            rows: cellsY,
            screenW,
            screenH,
          });
          if (layout) desiredDragHint = {
            nodeId: dragHint.nodeId,
            text: dragHint.text,
            layout,
          };
        } else {
          useDragHintStore.getState().remove(dragHint.nodeId);
        }
      }
      const presentedDragHint = reconcileDragHintPresentationFrame(
        desiredDragHint,
        dragHint,
        now,
      );
      if (presentedDragHint) {
        const shown: { col: number; row: number }[] = [];
        const cells = presentedDragHint.layout.cells;
        for (let k = 0; k < cells.length; k++) {
          if (!isCharShown(
            k,
            cells.length,
            presentedDragHint.startedAt,
            presentedDragHint.clearedAt,
            now,
          )) continue;
          const cell = cells[k]!;
          const cellIndex = cell.row * cellsX + cell.col;
          const base = cellIndex * 4;
          if (!placeBorrowedOverlayGlyph(data, base, cell.glyphIndex)) continue;
          protectedLabelCellIndices.add(cellIndex);
          shown.push({ col: cell.col, row: cell.row });
        }
        if (shown.length > 0) statusBoxes.push(presentedDragHint.layout.rect);
        const HR = LABEL_HALO_RADIUS_CELLS;
        for (const cell of shown) {
          for (let dr = -HR; dr <= HR; dr++) {
            const row = cell.row + dr;
            if (row < 0 || row >= cellsY) continue;
            for (let dc = -HR; dc <= HR; dc++) {
              const col = cell.col + dc;
              if (col < 0 || col >= cellsX) continue;
              const dist = Math.sqrt(dc * dc + dr * dr);
              if (dist > HR) continue;
              const dem = Math.round(LABEL_HALO_MAX_STAGES * (1 - dist / HR));
              const gByte = (row * cellsX + col) * 4 + 1;
              if (dem > data[gByte]!) data[gByte] = dem;
            }
          }
        }
      }
      // ── Project sync state beside the hovered sidebar row. ──
      // This is part of the real ASCII field—not a DOM tooltip. It takes the
      // project's RGB, inherits the opacity of each occupied field cell, types
      // on/backspaces, clears a negative aura, and yields to node/status text.
      {
        const syncStore = useProjectSyncLabelStore.getState();
        const canvasTop = container?.getBoundingClientRect().top ?? 0;
        const blockedRects = [
          ...statusBoxes,
          ...[...sc.auras.values()].map((aura) => ({
            x: aura.rect.x * v.zoom + v.x,
            y: aura.rect.y * v.zoom + v.y,
            w: aura.rect.w * v.zoom,
            h: aura.rect.h * v.zoom,
          })),
        ];
        const entries = Object.values(syncStore.entries)
          .sort((a, b) => Number(a.clearedAt == null) - Number(b.clearedAt == null));
        for (const entry of entries) {
          if (statusFullyDeleted(entry.text, entry.clearedAt, now)) {
            syncStore.remove(entry.projectId);
            continue;
          }
          const layout = layoutProjectSyncLabel({
            text: entry.text,
            anchorY: entry.anchorViewportY - canvasTop,
            leftInsetPx: sidebarInsetPx,
            blockedRects,
            cellPx: CELL,
            cols: cellsX,
            rows: cellsY,
            screenW,
            screenH,
          });
          if (!layout) continue;
          const colorIdx = colorIndexForAccent(entry.accent);
          const shown: { col: number; row: number }[] = [];
          for (let k = 0; k < layout.cells.length; k++) {
            if (!isCharShown(k, layout.cells.length, entry.startedAt, entry.clearedAt, now)) continue;
            const cell = layout.cells[k]!;
            const cellIndex = cell.row * cellsX + cell.col;
            const base = cellIndex * 4;
            if (!placeProjectColorOverlayGlyph(data, base, cell.glyphIndex, colorIdx, {
              protectedCell: protectedLabelCellIndices.has(cellIndex),
              replaceExisting: entry.clearedAt == null,
            })) continue;
            shown.push({ col: cell.col, row: cell.row });
          }
          if (shown.length > 0) {
            statusBoxes.push(layout.rect);
            blockedRects.push(layout.rect);
          }
          const HR = LABEL_HALO_RADIUS_CELLS;
          for (const cell of shown) {
            for (let dr = -HR; dr <= HR; dr++) {
              const row = cell.row + dr;
              if (row < 0 || row >= cellsY) continue;
              for (let dc = -HR; dc <= HR; dc++) {
                const col = cell.col + dc;
                if (col < 0 || col >= cellsX) continue;
                const dist = Math.sqrt(dc * dc + dr * dr);
                if (dist > HR) continue;
                const dem = Math.round(LABEL_HALO_MAX_STAGES * (1 - dist / HR));
                if (dem <= 0) continue;
                const gByte = (row * cellsX + col) * 4 + 1;
                if (dem > data[gByte]!) data[gByte] = dem;
              }
            }
          }
        }
      }
      // ── Zoom-dependent ASCII labels. ──
      // Arrow headers own zoom >= 35%; group-cluster names own zoom < 35%.
      // Both keep their last layout while deleting, so crossing the boundary
      // looks like a type-off/type-on handover rather than a hard cut.
      {
        const project = useGraphStore.getState().project;
        if (project) {
          const auras = sc.auras;
          const anchors = useArrowAnchorsStore.getState().anchors;
          const leftInsetPx = sidebarInsetPx;
          const mode = groupLabelMode(v.zoom);

          // Live aura owners (for arrow-label colour sampling) + node-card
          // screen rects shared by both placement systems.
          const owners: AuraOwner[] = [];
          const reserved = statusBoxes.slice();
          const recordIndexByAura = new Map<string, number>();
          let auraRecordIndex = 0;
          for (const a of auras.values()) {
            owners.push({ nodeId: a.id, rect: a.rect, accent: a.accent, focused: a.focused });
            reserved.push({ x: a.rect.x * v.zoom + v.x, y: a.rect.y * v.zoom + v.y, w: a.rect.w * v.zoom, h: a.rect.h * v.zoom });
            if (auraRecordIndex < MAX_RECORDS) recordIndexByAura.set(a.id, auraRecordIndex);
            auraRecordIndex++;
          }
          const toBBox = (r: { x: number; y: number; w: number; h: number }): BBox =>
            ({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h });
          const visFully = (id: string): boolean => {
            const a = auras.get(id);
            return a ? bboxFullyVisible({
              bbox: toBBox(a.rect), viewport: v, containerW: screenW, containerH: screenH, leftInsetPx,
            }) : false;
          };
          const visPartial = (id: string): boolean => {
            const a = auras.get(id);
            return a ? bboxIntersectsViewport({ bbox: toBBox(a.rect), viewport: v, containerW: screenW, containerH: screenH }) : false;
          };
          // Each arrow's world polyline: routed anchors when present, else a
          // straight line between the two node centres (computeArrowLabels
          // clips it to the card borders either way), plus the endpoint card
          // rects that clip defines the visible span against.
          const arrows: {
            id: string; fromNodeId: string; toNodeId: string;
            points: { x: number; y: number }[];
            fromRect: { x: number; y: number; w: number; h: number };
            toRect: { x: number; y: number; w: number; h: number };
          }[] = [];
          for (const arrowId in project.arrows) {
            const arr = project.arrows[arrowId];
            if (!arr || !isArrowVisible(arr, project.selection)) continue;
            const fromA = auras.get(arr.fromNodeId);
            const toA = auras.get(arr.toNodeId);
            if (!fromA || !toA) continue;
            const chain = anchors[arrowId];
            let points: { x: number; y: number }[];
            if (chain && chain.length >= 2) {
              points = chain;
            } else {
              points = [
                { x: fromA.rect.x + fromA.rect.w / 2, y: fromA.rect.y + fromA.rect.h / 2 },
                { x: toA.rect.x + toA.rect.w / 2, y: toA.rect.y + toA.rect.h / 2 },
              ];
            }
            arrows.push({
              id: arrowId, fromNodeId: arr.fromNodeId, toNodeId: arr.toNodeId,
              points, fromRect: fromA.rect, toRect: toA.rect,
            });
          }

          const arrowSegments: Segment[] = [];
          for (const arrow of arrows) {
            for (let i = 0; i + 1 < arrow.points.length; i++) {
              const from = arrow.points[i]!;
              const to = arrow.points[i + 1]!;
              arrowSegments.push({
                x1: from.x * v.zoom + v.x,
                y1: from.y * v.zoom + v.y,
                x2: to.x * v.zoom + v.x,
                y2: to.y * v.zoom + v.y,
              });
            }
          }

          const labelDebug: ArrowLabelDebug | undefined =
            process.env.NODE_ENV !== 'production' && mode === 'arrow'
              ? { arrows: 0, noVisibleSpan: 0, tooShort: 0, midpointOffscreen: 0, emptyHeader: 0, tooManyLines: 0, noPlacement: 0, placed: 0, maxCols: 0, cellPx: 0, screenW: 0, screenH: 0 }
              : undefined;
          let signature = 2166136261;
          const mix = (value: number) => {
            signature ^= value | 0;
            signature = Math.imul(signature, 16777619);
          };
          const mixText = (value: string) => {
            for (let i = 0; i < value.length; i++) mix(value.charCodeAt(i));
          };
          for (const aura of auras.values()) {
            mixText(aura.id);
            mix(Math.round(aura.rect.x * 10)); mix(Math.round(aura.rect.y * 10));
            mix(Math.round(aura.rect.w * 10)); mix(Math.round(aura.rect.h * 10));
            mix(aura.focused ? 1 : 0);
          }
          for (const rect of statusBoxes) {
            mix(Math.round(rect.x)); mix(Math.round(rect.y));
            mix(Math.round(rect.w)); mix(Math.round(rect.h));
          }
          for (const node of Object.values(project.nodes)) {
            mixText(nodeArrowLabelHeader(node));
          }
          for (const group of Object.values(project.groups)) mixText(group.name);
          for (const arrow of arrows) mixText(arrow.id);
          const placementKey = [
            mode,
            useArrowAnchorsStore.getState().revision,
            v.x.toFixed(2), v.y.toFixed(2), v.zoom.toFixed(4),
            screenW, screenH, CELL, leftInsetPx, signature,
          ].join('|');
          if (placementKey !== labelPlacementCacheKey) {
            labelPlacementCacheKey = placementKey;
            cachedArrowPlacements = mode === 'arrow'
              ? computeArrowLabels({
                arrows,
                headerOf: (id) => nodeArrowLabelHeader(project.nodes[id]),
                fullyVisible: visFully,
                partiallyVisible: visPartial,
                parentAccentOf: (id) => auras.get(id)?.accent ?? null,
                viewport: { x: v.x, y: v.y, zoom: v.zoom },
                screenW, screenH, cellPx: CELL,
                reserved, owners,
                debug: labelDebug,
              })
              : [];
            const groupClusters = mode === 'group'
              ? computeGroupClusters([...auras.values()].map((aura): GroupClusterNode => {
                  const groupId = project.nodes[aura.id]?.groupId;
                  if (groupId && project.groups[groupId]) {
                    return {
                      id: aura.id,
                      groupId,
                      target: { kind: 'group' as const, groupId },
                      rect: aura.rect,
                    };
                  }
                  return {
                    id: aura.id,
                    groupId: projectUngroupedClusterKey(project.id),
                    target: { kind: 'ungrouped' as const },
                    rect: aura.rect,
                  };
                }))
              : [];
            cachedGroupPlacements = mode === 'group'
              ? computeGroupLabels({
                  clusters: groupClusters,
                  groupNameOf: (groupId) => groupId === projectUngroupedClusterKey(project.id)
                    ? project.name
                    : project.groups[groupId]?.name ?? '',
                  viewport: { x: v.x, y: v.y, zoom: v.zoom },
                  screenW,
                  screenH,
                  cellPx: CELL,
                  leftInsetPx,
                  reserved,
                  segments: arrowSegments,
                })
              : [];
          }
          const placements = cachedArrowPlacements;
          if (labelDebug) (window as unknown as { __arrowLabelStats?: object }).__arrowLabelStats = labelDebug;

          const desiredArrows = new Map<string, DesiredLabel>();
          for (const p of placements) desiredArrows.set(p.arrowId, {
            text: p.text,
            targetNodeId: p.targetNodeId,
            hitRect: p.hitRect,
            cells: p.cells,
            accents: p.accents,
          });
          const hiddenArrowIds = new Set(Object.values(project.arrows)
            .filter((arrow) => !isArrowVisible(arrow, project.selection)).map((arrow) => arrow.id));
          useArrowLabelStore.getState().reconcile(desiredArrows, now, hiddenArrowIds);

          const groupPlacements = cachedGroupPlacements;
          const desiredGroups = new Map<string, DesiredGroupLabel>();
          for (const placement of groupPlacements) {
            const colorSourceNodeId = placement.memberNodeIds.find((id) => recordIndexByAura.has(id));
            if (!colorSourceNodeId) continue;
            desiredGroups.set(placement.clusterId, {
              text: placement.text,
              groupId: placement.groupId,
              target: placement.target,
              colorSourceNodeId,
              rect: placement.rect,
              cells: placement.cells,
            });
          }
          useGroupLabelStore.getState().reconcile(desiredGroups, now);

          const HR = LABEL_HALO_RADIUS_CELLS;
          const paintHalo = (shown: readonly { col: number; row: number }[]) => {
            for (const c of shown) {
              for (let dr = -HR; dr <= HR; dr++) {
                const row = c.row + dr;
                if (row < 0 || row >= cellsY) continue;
                for (let dc = -HR; dc <= HR; dc++) {
                  const col = c.col + dc;
                  if (col < 0 || col >= cellsX) continue;
                  const dist = Math.sqrt(dc * dc + dr * dr);
                  if (dist > HR) continue;
                  const dem = Math.round(LABEL_HALO_MAX_STAGES * (1 - dist / HR));
                  if (dem <= 0) continue;
                  const gByte = (row * cellsX + col) * 4 + 1;
                  if (dem > data[gByte]!) data[gByte] = dem;
                }
              }
            }
          };

          const drawArrowLabels = () => {
            const entries = Object.values(useArrowLabelStore.getState().entries)
              .sort((a, b) => Number(a.clearedAt == null) - Number(b.clearedAt == null));
            const allShown: { col: number; row: number }[] = [];
            for (const entry of entries) {
              const total = entry.cells.length;
              const animateTitle = entry.clearedAt == null && isImageTitlePending(project.nodes[entry.targetNodeId]);
              for (let k = 0; k < total; k++) {
                if (!isCharShown(k, total, entry.startedAt, entry.clearedAt, now)) continue;
                if (animateTitle && !generatingTitleDotVisible(k, total, now)) continue;
                const cell = entry.cells[k]!;
                if (cell.col < 0 || cell.col >= cellsX || cell.row < 0 || cell.row >= cellsY) continue;
                const cellIndex = cell.row * cellsX + cell.col;
                const base = cellIndex * 4;
                if (!placeArrowOverlayGlyph(data, base, cell.glyphIndex, {
                  dragHintOccupied: protectedLabelCellIndices.has(cellIndex),
                })) continue;
                allShown.push({ col: cell.col, row: cell.row });
              }
            }
            paintHalo(allShown);
          };

          const drawGroupLabels = () => {
            const entries = Object.values(useGroupLabelStore.getState().entries)
              .sort((a, b) => Number(a.clearedAt == null) - Number(b.clearedAt == null));
            const allShown: { col: number; row: number }[] = [];
            for (const entry of entries) {
              const recordIndex = recordIndexByAura.get(entry.colorSourceNodeId);
              if (recordIndex == null) continue;
              const total = entry.cells.length;
              for (let k = 0; k < total; k++) {
                if (!isCharShown(k, total, entry.startedAt, entry.clearedAt, now)) continue;
                const cell = entry.cells[k]!;
                if (cell.col < 0 || cell.col >= cellsX || cell.row < 0 || cell.row >= cellsY) continue;
                const cellIndex = cell.row * cellsX + cell.col;
                const base = cellIndex * 4;
                if (!placeGroupOverlayGlyph(data, base, cell.glyphIndex, recordIndex, {
                  protectedCell: protectedLabelCellIndices.has(cellIndex),
                  replaceExisting: true,
                })) continue;
                allShown.push({ col: cell.col, row: cell.row });
              }
            }
            paintHalo(allShown);
          };

          // Paint the outgoing kind first. The newly active kind then wins any
          // brief overlap while the old glyphs backspace away.
          if (mode === 'group') {
            drawArrowLabels();
            drawGroupLabels();
          } else {
            drawGroupLabels();
            drawArrowLabels();
          }
        }
      }
      s.statusColorCount = colorCount;

      // ── Arrow fade → G (stage-demote, MAX over overlapping segments). ──
      paintArrowDimming(data, useArrowAnchorsStore.getState().anchors,
        useGraphStore.getState().project, v, CELL, cellsX, cellsY);

      const graph = useGraphStore.getState();
      const project = graph.project;
      const gesture = useCanvasSelectionStore.getState().marquee;
      const marquee = gesture?.projectId === project?.id ? gesture?.rect ?? null : null;
      if (project && (isBatchNodeSelection(project.selection, graph.selectedGroupId) || marquee)) {
        const selectedAuras = project.selection.flatMap((id) => {
          const aura = sc.auras.get(id);
          return aura ? [{ rect: {
            x: aura.rect.x * v.zoom + v.x, y: aura.rect.y * v.zoom + v.y,
            w: aura.rect.w * v.zoom, h: aura.rect.h * v.zoom,
          }, radius: AURA_RADIUS_FOCUSED * v.zoom }] : [];
        });
        const key = JSON.stringify([CELL, cellsX, cellsY, selectedAuras]);
        if (selectionBorderKey !== key) {
          selectionBorderKey = key;
          cachedSelectionBorder = selectionAuraBorder(selectedAuras, CELL, cellsX, cellsY);
        }
        const blocked = [...sc.auras.values()].map((aura) => ({
          x: aura.rect.x * v.zoom + v.x, y: aura.rect.y * v.zoom + v.y,
          w: aura.rect.w * v.zoom, h: aura.rect.h * v.zoom,
        }));
        paintSelectionOverlay(data, cellsX, cellsY, CELL, cachedSelectionBorder, marquee, blocked);
      }
    };

    const render = (now: number) => {
      const s = stateRef.current;
      const g = glRef.current;
      if (!g) return;
      const { gl } = g;
      const sc = scene.state;
      const t0 = performance.now();

      const tintFallback: AuraTintFallback = {
        baseline: s.baselineColor,
        aura: s.auraColor,
      };
      const resolveTint = (accent: Parameters<typeof resolveAuraTintNumeric>[0]) =>
        resolveAuraTintNumeric(accent, tintFallback);

      // Zoom flips reset cooling history (see onDirty note).
      if (sc.viewport.zoom !== s.lastZoom) s.lastZoom = sc.viewport.zoom;

      // ── Pack + upload records. ──
      const count = packRecords(
        sc.auras.values(), sc.ghosts.values(), sc.waves, sc.focusEchoes, now, resolveTint, s.records,
      );
      gl.bindTexture(gl.TEXTURE_2D, g.recordsTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        Math.max(1, count) * 4, 1, gl.RGBA, gl.FLOAT,
        s.records.subarray(0, Math.max(1, count) * FLOATS_PER_RECORD),
      );

      // ── Palette (only on membership/theme change). ──
      if (s.paletteVersion !== sc.paletteVersion) {
        s.paletteVersion = sc.paletteVersion;
        const neutralTint = resolveTint(null);
        const built = buildBaselinePaletteVec4(
          sc.baselineAccents, sc.anyUngrouped, resolveTint,
          { r: neutralTint.r, g: neutralTint.g, b: neutralTint.b, a: neutralTint.alphaBase },
        );
        s.paletteData = built.data;
        s.paletteCount = built.count;
      }
      const neutral = resolveTint(null);

      gl.bindVertexArray(g.vao);
      gl.disable(gl.BLEND);

      // ── Pass A — cell state into the write target. ──
      const readTex = g.writeA ? g.stateTexB : g.stateTexA;
      const writeFbo = g.writeA ? g.fboA : g.fboB;
      const writtenTex = g.writeA ? g.stateTexA : g.stateTexB;
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
      gl.viewport(0, 0, s.cellsX, s.cellsY);
      gl.useProgram(g.progA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, g.recordsTex);
      gl.uniform1i(g.aRecords, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.uniform1i(g.aPrevState, 1);
      gl.uniform1i(g.aRecordCount, count);
      gl.uniform3f(g.aViewport, sc.viewport.x, sc.viewport.y, sc.viewport.zoom);
      gl.uniform1f(g.aCellCssPx, s.deviceCellPx / s.dpr);
      gl.uniform1f(g.aDtMs, s.lastPassATime === 0 ? 0 : now - s.lastPassATime);
      gl.uniform1f(g.aCoolRate, sc.coolStagesPerSecond ?? COOL_STAGES_PER_SEC);
      gl.uniform1i(g.aResetHistory, s.resetHistory ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      s.lastPassATime = now;
      s.resetHistory = false;
      g.writeA = !g.writeA;

      // ── Part F/G overlay — build on the CPU + upload (status + fade). ──
      buildOverlay(now, resolveTint);
      gl.bindTexture(gl.TEXTURE_2D, g.overlayTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        s.cellsX, s.cellsY, gl.RGBA, gl.UNSIGNED_BYTE, s.overlayData,
      );

      // ── Pass B — composite to the canvas. ──
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, s.deviceW, s.deviceH);
      gl.useProgram(g.progB);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, writtenTex);
      gl.uniform1i(g.bCellState, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, g.recordsTex);
      gl.uniform1i(g.bRecords, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, g.atlasTex);
      gl.uniform1i(g.bAtlas, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, g.overlayTex);
      gl.uniform1i(g.bOverlay, 3);
      gl.uniform4fv(g.bStatusColors, s.statusColorData);
      gl.uniform4fv(g.bPalette, s.paletteData);
      gl.uniform1i(g.bPaletteCount, s.paletteCount);
      gl.uniform4f(g.bNeutral, neutral.r, neutral.g, neutral.b, neutral.alphaBase);
      gl.uniform1f(g.bAlphaBoost, s.alphaBoost);
      gl.uniform1f(g.bDeviceCellPx, s.deviceCellPx);
      gl.uniform1f(g.bCellCssPx, s.deviceCellPx / s.dpr);
      gl.uniform3f(g.bViewport, sc.viewport.x, sc.viewport.y, sc.viewport.zoom);
      gl.uniform1f(g.bCanvasHpx, s.deviceH);
      gl.uniform2i(g.bCellsMax, s.cellsX - 1, s.cellsY - 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);

      // Dev instrumentation — the honest before/after metric.
      if (process.env.NODE_ENV !== 'production') {
        const cpuMs = performance.now() - t0;
        s.frames++;
        s.emaCpuMs = s.emaCpuMs === 0 ? cpuMs : s.emaCpuMs * 0.95 + cpuMs * 0.05;
        if (cpuMs > s.worstCpuMs) s.worstCpuMs = cpuMs;
        (window as unknown as { __auraStats?: object }).__auraStats = {
          renderer: 'gl',
          frames: s.frames,
          emaCpuMs: +s.emaCpuMs.toFixed(3),
          worstCpuMs: +s.worstCpuMs.toFixed(3),
          records: count,
          gpuMs: null, // needs EXT_disjoint_timer_query_webgl2 — not wired
        };
      }
    };

    const unregisterCapture = registerScreenshotRenderer(canvas, pixelRatio => {
      pixelRatio = Math.max(Math.ceil(pixelRatio), 1);
      const s = stateRef.current;
      const gl = glRef.current?.gl;
      if (!gl || gl.isContextLost()) throw new Error('The ASCII renderer is unavailable. Reload and retry.');
      const max = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 16384);
      if (s.containerW * pixelRatio > max || s.containerH * pixelRatio > max
        || s.containerW * s.containerH * pixelRatio * pixelRatio > 40_000_000) {
        throw new Error('This selection needs more graphics memory than the capture limit. Enlarge the selection; no lower-resolution substitute was saved.');
      }
      try {
        capturePixelRatio = Math.max(Math.ceil(pixelRatio), 1);
        ensureSized(); render(performance.now());
        // Read immediately: the normal WebGL canvas need not preserve buffers.
        return canvas.toDataURL('image/png');
      } finally {
        capturePixelRatio = undefined;
        ensureSized(); render(performance.now());
        s.dirty = true;
      }
    });

    // rAF loop, gated by Page-Visibility + IntersectionObserver (no throttle:
    // the GPU recomputes every cell every frame, so it runs at refresh rate).
    let rafId: number | null = null;
    let docVisible = typeof document === 'undefined' || !document.hidden;
    let viewportVisible = true;
    const isAwake = () => docVisible && viewportVisible;

    const loop = (now: number) => {
      rafId = requestAnimationFrame(loop);
      const s = stateRef.current;
      scene.pruneExpired(now);
      const transitioning = scene.evalIntensities(now);
      const sc = scene.state;
      const active = sc.waves.size > 0 || sc.ghosts.size > 0 || transitioning
        || statusAwake(now) || labelAwake(now) || dragHintAwake(now);
      if (s.dirty || active) s.lastActivity = now;
      if (!s.fontReady) return;
      if (now - s.lastActivity > COOL_TAIL_MS) return; // idle
      if (!ensureSized()) return;
      s.dirty = false;
      render(now);
    };

    const start = () => {
      if (rafId !== null) return;
      stateRef.current.dirty = true;
      rafId = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (rafId === null) return;
      cancelAnimationFrame(rafId);
      rafId = null;
    };

    const onVisibility = () => {
      docVisible = !document.hidden;
      if (isAwake()) start();
      else stop();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    let io: IntersectionObserver | null = null;
    const container = containerRef.current;
    if (container && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        viewportVisible = entry.isIntersecting;
        if (isAwake()) start();
        else stop();
      }, { threshold: 0 });
      io.observe(container);
    }

    if (isAwake()) start();

    return () => {
      unregisterCapture();
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (io) io.disconnect();
      unsubscribeDragHint();
      unsubscribeProjectSyncLabel();
      unsubscribeSelection();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      // Delete resources but do NOT loseContext(): React StrictMode
      // re-runs this effect in development, and getContext('webgl2')
      // on the same canvas returns the SAME context object — killing
      // it here would hand the remount a permanently lost context
      // (every shader compile fails with a null info log).
      const g = glRef.current;
      if (g && !g.gl.isContextLost()) {
        g.gl.deleteProgram(g.progA);
        g.gl.deleteProgram(g.progB);
        g.gl.deleteVertexArray(g.vao);
        g.gl.deleteTexture(g.recordsTex);
        g.gl.deleteTexture(g.atlasTex);
        g.gl.deleteTexture(g.overlayTex);
        g.gl.deleteTexture(g.stateTexA);
        g.gl.deleteTexture(g.stateTexB);
        g.gl.deleteFramebuffer(g.fboA);
        g.gl.deleteFramebuffer(g.fboB);
      }
      glRef.current = null;
      // Force full re-init (sizes, atlas, history) if the effect re-runs.
      const s = stateRef.current;
      s.deviceW = 0;
      s.deviceH = 0;
      s.cellsX = 0;
      s.cellsY = 0;
      s.dpr = 0;
      s.atlasBuiltForCellPx = 0;
      s.overlayKey = '';
      s.resetHistory = true;
      s.dirty = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, renderAppOverlays]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
