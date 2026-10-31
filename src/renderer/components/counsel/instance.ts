export interface CounselInstance {
  sessionId: string;
  projectId: string;
  element: HTMLElement;
  destroy(): void;
}

export const instances = new Map<string, CounselInstance>();

export function getCounselInstance(sessionId: string): CounselInstance | undefined {
  return instances.get(sessionId);
}
