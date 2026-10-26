export const DEFAULT_CAMERA_AUTO_PAN = {
  focus: true,
  groups: true,
  newNodes: true,
  branchProjects: true,
  generation: true,
  rootGeneration: true,
  expand: true,
  panels: true,
  reading: true,
  delete: true,
  dragEdges: true,
};

export type CameraAutoPan = typeof DEFAULT_CAMERA_AUTO_PAN;
export type CameraPanTrigger = Exclude<keyof CameraAutoPan, 'generation' | 'dragEdges'>;

export function normalizeCameraAutoPan(value: unknown): CameraAutoPan {
  const raw = value && typeof value === 'object' ? value as Partial<CameraAutoPan> : {};
  return Object.fromEntries(Object.entries(DEFAULT_CAMERA_AUTO_PAN).map(([key, fallback]) => [
    key, typeof raw[key as keyof CameraAutoPan] === 'boolean' ? raw[key as keyof CameraAutoPan] : fallback,
  ])) as CameraAutoPan;
}
