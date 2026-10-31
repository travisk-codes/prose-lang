import type { Plugin } from "vite";

export interface ProsePluginOptions {
  /** Keep each file's .d.prose.ts declarations current as it compiles. */
  declarations?: boolean;
}

export default function prose(options?: ProsePluginOptions): Plugin;
