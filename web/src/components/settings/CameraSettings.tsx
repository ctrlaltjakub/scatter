'use client';

import type { CameraAutoPan } from '@/lib/cameraPreferences';
import { useSettingsStore } from '@/store/useSettingsStore';
import { CollapsibleSection } from '../dev/CollapsibleSection';
import { SettingsToggle } from './SettingsSection';

// Exhaustive: adding a preference requires a visible settings control too.
const BEHAVIORS: Record<keyof CameraAutoPan, { title: string; description: string }> = {
  focus: { title: 'When focusing a node', description: 'Bring a clicked node and its panels into view.' },
  groups: { title: 'When selecting a group', description: 'Fit the selected group from the sidebar or canvas. Also applies to the canvas label for ungrouped nodes.' },
  newNodes: { title: 'When creating a node', description: 'Bring the new node into view alongside its parent.' },
  branchProjects: { title: 'When creating a project from a branch', description: 'Fit the copied branch when its new project opens.' },
  generation: { title: 'While generating content', description: 'Keep following a growing node after the camera moves to it.' },
  rootGeneration: { title: 'While creating the first node', description: 'Keep the project’s first node in view during its initial generation. Any click, scroll, or keyboard action on the canvas stops following. Regeneration is excluded.' },
  expand: { title: 'When expanding bullets', description: 'Keep the expanded node in view after its height changes.' },
  panels: { title: 'When opening node panels', description: 'Make room for chat history, fact-check results, and free images.' },
  reading: { title: 'When starting the reading ruler', description: 'Bring the node into view when keyboard reading starts.' },
  delete: { title: 'After deleting a node', description: 'Return to its parent when that parent still exists.' },
  dragEdges: { title: 'When dragging nodes near canvas edges', description: 'Move the camera as you drag a node or selection toward an edge. Resizing does not move the camera.' },
};
const BEHAVIOR_KEYS = Object.keys(BEHAVIORS) as Array<keyof CameraAutoPan>;

export function CameraSettings() {
  const preferences = useSettingsStore(s => s.cameraAutoPan);
  const setPreference = useSettingsStore(s => s.setCameraAutoPan);
  return <CollapsibleSection title="Automatic camera movement"
    description={<>Choose when the app automatically <strong>pans or adjusts zoom</strong>.</>}>
    <p className="field-help">Manual navigation, search results, linked terms, and <strong>Fit node to screen</strong> still work. Camera fits never exceed <strong>100% zoom</strong>; manual zoom can go higher.</p>
    {BEHAVIOR_KEYS.map(key => <SettingsToggle key={key}
      title={BEHAVIORS[key].title} description={BEHAVIORS[key].description} checked={preferences[key]}
      onChange={value => setPreference(key, value)} />)}
  </CollapsibleSection>;
}
