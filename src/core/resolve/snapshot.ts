import type { CascadeSource, Declaration, Diagnostic, PropertyRegistration, StyleSheetRef } from '../model';

/** Plain-data CSSOM capture. All selector matching and computed values belong to the host. */
export interface RuleSnapshot {
  source: CascadeSource;
  declarations: Declaration[];
}
export interface SheetSnapshot {
  sheet: StyleSheetRef;
  rules: RuleSnapshot[];
  registrations?: PropertyRegistration[];
  diagnostics?: Diagnostic[];
}
