'use client';

import { useEffect } from 'react';
import { markAppVisited } from '@/lib/deployment';

export function DeploymentRuntime() {
  useEffect(() => { markAppVisited(); }, []);
  return null;
}
