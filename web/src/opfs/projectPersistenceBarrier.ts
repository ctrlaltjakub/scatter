const pending = new Map<string, Promise<void>>();

/** Register the newest coordinator-owned write so reads cannot overtake it. */
export function trackProjectPersistence(projectId: string, task: Promise<void>): void {
  pending.set(projectId, task);
  void task.finally(() => {
    if (pending.get(projectId) === task) pending.delete(projectId);
  }).catch(() => {
    // The original task retains error ownership; this branch only prevents the
    // cleanup promise from becoming an unhandled rejection.
  });
}

export async function waitForProjectPersistence(projectId: string): Promise<void> {
  const task = pending.get(projectId);
  if (task) await task;
}
