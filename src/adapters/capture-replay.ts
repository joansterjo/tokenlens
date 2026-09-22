import type { SheetSnapshot } from '../core/resolve/snapshot';
export function captureReplay(snapshot: SheetSnapshot[]): SheetSnapshot[] { return structuredClone(snapshot); }
