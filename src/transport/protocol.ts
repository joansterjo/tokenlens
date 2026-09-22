export const PORT_DEVTOOLS = (tabId: number) => `devtools:${tabId}`;
export const PORT_CONTENT   = (frameId: number) => `content:${frameId}`;
export const PROTOCOL_VERSION = 1 as const;

export type MsgType =
  | 'resync' | 'pick:start' | 'pick:stop' | 'pick:hover' | 'pick:locked'
  | 'report:request' | 'report:result'
  | 'edit:apply' | 'edit:revert' | 'edit:verified' | 'edit:blast-radius'
  | 'audit:start' | 'audit:progress' | 'audit:result' | 'audit:cancel'
  | 'swatches:request' | 'swatches:result'
  | 'eyedropper:arm' | 'eyedropper:result'
  | 'sheet:fetch' | 'sheet:fetched'
  | 'nav:changed' | 'theme:changed' | 'diag';

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;                                     // uuid; replies echo it
  type: MsgType;
  tabId?: number; frameId?: number; documentId?: string;
  payload: T;
}
