import { compile } from "./emitter.js";

export { camel } from "./names.js";
export { continues, sourceLines } from "./layout.js";
export { markupExpressionAt } from "./lexer.js";
export { parse } from "./parser.js";
export { compile };

/**
 * Compile the supported Prose subset into JavaScript. Pass `runtime` (a module path) to import
 * the runtime helpers instead of embedding them, and `readModule(path)` to return the source of
 * an imported `.prose` file so its functions can be called like local ones.
 */
export function transpile(source, options = {}) {
  return compile(source, options).code;
}
