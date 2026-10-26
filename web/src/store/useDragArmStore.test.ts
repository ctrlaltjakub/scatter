import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDragArmStore } from './useDragArmStore';

beforeEach(() => useDragArmStore.getState().setArmed(null));

describe('useDragArmStore', () => {
  it('starts unarmed', () => {
    expect(useDragArmStore.getState().armedNodeId).toBeNull();
    expect(useDragArmStore.getState().strength).toBe(0);
  });

  it('stores clamped strength and clears it when disarmed', () => {
    useDragArmStore.getState().setArmed('n1', 0.5);
    expect(useDragArmStore.getState()).toMatchObject({
      armedNodeId: 'n1',
      strength: 0.5,
    });
    useDragArmStore.getState().setArmed('n1', 2);
    expect(useDragArmStore.getState().strength).toBe(1);
    useDragArmStore.getState().setArmed(null);
    expect(useDragArmStore.getState()).toMatchObject({
      armedNodeId: null,
      strength: 0,
    });
  });

  it('notifies for strength changes but not identical drag-hot-path state', () => {
    useDragArmStore.getState().setArmed('n1', 0.25);
    const listener = vi.fn();
    const unsub = useDragArmStore.subscribe(listener);
    useDragArmStore.getState().setArmed('n1', 0.25);
    useDragArmStore.getState().setArmed('n1', 0.25);
    expect(listener).not.toHaveBeenCalled();
    useDragArmStore.getState().setArmed('n1', 0.5);
    expect(listener).toHaveBeenCalledTimes(1);
    useDragArmStore.getState().setArmed('n2', 0.5);
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });
});
