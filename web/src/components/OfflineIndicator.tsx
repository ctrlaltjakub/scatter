'use client';

import { useIsBrowserOnline } from '@/lib/networkStatus';

export function OfflineIndicator() {
  const online = useIsBrowserOnline();
  if (online) return null;

  return (
    <span className="sidebar-offline" role="status">
      offline
    </span>
  );
}
