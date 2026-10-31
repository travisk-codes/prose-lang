export interface RawSourceMap {
  version: number;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export interface CompileOptions {
  /** A module specifier to import runtime helpers from instead of embedding them. */
  runtime?: string;
  /** Returns the source of an imported .prose file. */
  readModule?: (specifier: string) => string;
  /** true for a separate map, "inline" to embed it too, or false (default). */
  sourceMap?: boolean | "inline";
  /** The original source path or URL recorded in a map. */
  filename?: string;
  /** Generate TypeScript for type checking instead of executable JavaScript. */
  check?: boolean;
  [key: string]: unknown;
}

export interface CompileResult {
  code: string;
  map: RawSourceMap | null;
  module: boolean;
  declarations: string | null;
  jsx?: boolean;
}

export function compile(source: string, options?: CompileOptions): CompileResult;
export function transpile(source: string, options?: CompileOptions): string;

export function parse(source: string, options?: CompileOptions): unknown;
export function camel(name: string): string;
export function continues(tokens: unknown[]): boolean;
export function sourceLines(source: string, options?: { locations?: boolean; embedded?: boolean }): unknown;
export function markupExpressionAt(source: string, line: number, column: number): unknown;
