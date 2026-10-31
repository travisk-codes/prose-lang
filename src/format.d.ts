export interface FormatOptions {
  /** Preferred line width; strings and unbreakable expressions may exceed it. */
  width?: number;
  /** Columns per indentation level. */
  tabWidth?: number;
  /** Indent with spaces (default) or tabs. */
  insertSpaces?: boolean;
  /** Retained line ending; defaults to the source's existing style. */
  endOfLine?: "\n" | "\r\n";
  /** Returns the source of an imported .prose file. */
  readModule?: (specifier: string) => string;
}

export function format(source: string, options?: FormatOptions): string;
