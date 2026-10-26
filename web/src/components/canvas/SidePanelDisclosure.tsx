'use client';

import { createContext, useContext, useState } from 'react';

export type SidePanelSection = 'text' | 'group' | 'fact' | 'wikimedia' | 'add';
// Transient navigation state, shared by every node type; not part of undo.
export const SidePanelDisclosureContext = createContext<{
  open: SidePanelSection | null;
  setOpen: (section: SidePanelSection | null) => void;
} | null>(null);

export function useSidePanelDisclosure(section: SidePanelSection) {
  const shared = useContext(SidePanelDisclosureContext);
  const [localOpen, setLocalOpen] = useState(false);
  return [shared ? shared.open === section : localOpen, (open: boolean) => {
    if (shared) shared.setOpen(open ? section : null);
    else setLocalOpen(open);
  }] as const;
}
