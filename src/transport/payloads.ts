import type { Edit, ElementTokenReport, Diagnostic, TokenCategory } from '../core/model';
export interface SessionPayload { report: ElementTokenReport | null; edits: Edit[]; }
export interface ApplyPayload { edits: Edit[]; transaction?: 'start' | 'update' | 'commit'; }
export interface VerifiedPayload { edits: Edit[]; diagnostics: Diagnostic[]; }
export interface AuditToken { name: string; value: string; category: TokenCategory; consumers: number; scopes: string[]; }
export interface AuditFinding { type: 'hardcoded' | 'orphan' | 'duplicate' | 'contrast'; message: string; token?: string; selector?: string; }
export interface AuditResult { tokens: AuditToken[]; findings: AuditFinding[]; scanned: number; total: number; truncated: boolean; }
