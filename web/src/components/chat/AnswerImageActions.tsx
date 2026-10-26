'use client';
import { ChevronDown, ChevronRight, Images, LoaderCircle, RotateCcw } from 'lucide-react';
import type { ScatterNode } from '@/store/types';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useWikimediaTaskStore, wikimediaTaskKey } from '@/store/useWikimediaTaskStore';
import { getFreeImageRecommendationSet } from '@/lib/freeImageRecommendations';
import { startWikimediaDiscovery, wikimediaSearchAvailability } from '@/lib/wikimediaDiscovery';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { useSidePanelDisclosure } from '../canvas/SidePanelDisclosure';

/** Same saved recommendations, availability rules and disclosure as text nodes. */
export function AnswerImageActions({ node }: { node: ScatterNode }) {
  const [, setImagesOpen] = useSidePanelDisclosure('wikimedia');
  const autoFreeImages = useSettingsStore(s => s.autoFreeImages);
  useSettingsStore(s => s.providers);
  useSettingsStore(s => s.activeModelRef);
  useSettingsStore(s => s.secondaryModelRef);
  useSettingsStore(s => s.secondaryUseSameModel);
  useSettingsStore(s => s.modelCompatibilityOverrides);
  useModelCatalogStore(s => s.catalog);
  const version = node.versions[node.currentVersionIndex]!;
  const open = useCitationPanelStore((s) => s.nodeId === node.id && s.mode === 'wikimedia' && s.wikimediaVersionCreatedAt === version.createdAt);
  const task = useWikimediaTaskStore((s) => s.tasks[wikimediaTaskKey(node.id, version.createdAt)]);
  const running = !!task?.running;
  const results = getFreeImageRecommendationSet(version);
  const generatingThisVersion = !!node.generating
    && (node.generatingVersionIndex ?? node.currentVersionIndex) === node.currentVersionIndex;
  const disabled = !results && generatingThisVersion && !running;
  const reason = generatingThisVersion ? 'Wait until this version has finished generating' : 'Search image catalogs directly; no AI requests';
  const availability = wikimediaSearchAvailability();
  const canRedo = !generatingThisVersion && !!version.body.trim() && availability.available;
  const redoReason = generatingThisVersion ? 'Wait until this version has finished generating'
    : !version.body.trim() ? 'Add text before running an AI image search'
      : availability.reason ?? 'Redo the AI-assisted image search for this node';
  return <>
    <button type="button" className={`side-action side-disclosure-trigger${open ? ' toggled' : ''}${disabled ? ' side-action--disabled' : ''}`}
      aria-disabled={disabled} aria-expanded={open} data-tip={results ? 'Show the freely reusable images saved for this version' : reason}
      onClick={() => {
        if (open) { setImagesOpen(false); useCitationPanelStore.getState().close(); }
        else if (!disabled) {
          setImagesOpen(true);
          useCitationPanelStore.getState().openWikimedia(node.id, version.createdAt);
        }
      }}>
      <span className={`side-action-icon${running ? ' is-spinning' : ''}`}>{running ? <LoaderCircle size={15} /> : <Images size={15} />}</span>
      <span className="side-action-label">{open ? 'Hide free images' : (!autoFreeImages || version.markdownNote) && !results && !task ? 'Search for free images' : 'Show free images'}</span>
      {!running && results && <span className="side-action-count">{results.results.length}</span>}
      <span className="side-disclosure-chevron">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
    </button>
    <AnimatedCollapse open={open}><div className="side-disclosure-content"><button type="button"
      className={`side-action${!canRedo || running ? ' side-action--disabled' : ''}`} aria-disabled={!canRedo || running}
      data-tip={running ? 'A fresh image search is already running' : redoReason}
      onClick={() => { if (canRedo && !running) void startWikimediaDiscovery(node.id, version.createdAt, { rerun: true }); }}>
      <span className={`side-action-icon${running ? ' is-spinning' : ''}`}>{running ? <LoaderCircle size={15} /> : <RotateCcw size={15} />}</span>
      {running ? 'Searching…' : 'Redo agentic search'}
    </button></div></AnimatedCollapse>
  </>;
}
