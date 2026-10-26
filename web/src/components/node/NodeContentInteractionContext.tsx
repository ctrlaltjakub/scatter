'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { NodeVersion } from '@/store/types';

interface NodeContentInteractionOverrides {
  /** Viewer text is screen-sized, so its terms must not inherit canvas zoom. */
  ignoreCanvasZoomForTerms?: boolean;
  /** Chat history/viewers render versions other than the node's active one. */
  citationVersionCreatedAt?: number;
  citationSources?: NodeVersion['sources'];
  citationInternalSources?: NodeVersion['internalSources'];
}

const NodeContentInteractionContext = createContext<NodeContentInteractionOverrides | null>(null);

export function NodeContentInteractionProvider({
  value,
  children,
}: {
  value: NodeContentInteractionOverrides;
  children: ReactNode;
}) {
  return (
    <NodeContentInteractionContext.Provider value={value}>
      {children}
    </NodeContentInteractionContext.Provider>
  );
}

export function useNodeContentInteraction(): NodeContentInteractionOverrides | null {
  return useContext(NodeContentInteractionContext);
}
