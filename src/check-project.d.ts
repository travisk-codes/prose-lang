export interface CheckDiagnostic {
  source: string;
  code: string | number;
  severity: "error" | "warning";
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
  relatedInformation?: unknown[];
}

export interface CheckOptions {
  cwd?: string;
  project?: string;
  targets?: string[];
  typescript?: unknown;
  overlays?: [string, string][];
  strict?: boolean;
  hoverTargets?: string[];
  definitionTargets?: string[];
  referenceTargets?: string[];
  referenceAll?: boolean;
  semanticTargets?: string[];
  completionProbe?: unknown;
  signatureProbe?: unknown;
}

export interface CheckResult {
  project: string | null;
  projectRoot: string;
  typescriptVersion: string;
  files: string[];
  diagnostics: CheckDiagnostic[];
  ignored: number;
  exitCode: number;
  strict?: true;
  hovers?: unknown[];
  definitions?: unknown[];
  references?: unknown[];
  semanticTokens?: unknown[];
  completions?: unknown[];
  signatureHelp?: unknown;
}

export class CheckSetupError extends Error {
  diagnostics: CheckDiagnostic[];
  constructor(message: string, diagnostics?: CheckDiagnostic[]);
}

export function checkProject(options?: CheckOptions): CheckResult;
