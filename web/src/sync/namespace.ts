import { releaseChannel } from '@/lib/deployment';
import type { RemoteObject } from './types';

const LOGICAL_PREFIX = 'scatter-v1.';

/** The namespace is deployment-owned, never restored from user settings. */
export class SyncNamespace {
  readonly beta = releaseChannel() === 'beta';
  readonly prefix = this.beta ? 'scatter-beta-v1.' : LOGICAL_PREFIX;
  readonly scopeSuffix = this.beta ? ':beta' : '';

  remoteName(name: string): string {
    if (!name.startsWith(LOGICAL_PREFIX)) throw new Error('Invalid sync object name.');
    return this.prefix + name.slice(LOGICAL_PREFIX.length);
  }

  localObject(object: RemoteObject): RemoteObject {
    if (!object.name.startsWith(this.prefix)) throw new Error('Sync object belongs to another release channel.');
    if (!this.beta) return object;
    return { ...object, name: LOGICAL_PREFIX + object.name.slice(this.prefix.length), namespace: 'beta' };
  }

  assertObject(object: RemoteObject): void {
    if ((object.namespace === 'beta') !== this.beta) {
      throw new Error('Stable and beta cloud snapshots are separate. Reconnect sync in this version of the app.');
    }
  }
}
