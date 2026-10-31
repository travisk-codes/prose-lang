// Async detection for functions, declarations, and top-level awaits.
// Whether a body waits for something itself (not just in functions inside it), which makes it asynchronous.
function awaits(node) {
  if (Array.isArray(node)) return node.some(awaits);
  if (!node || typeof node !== "object" || node.type === "lambda" || node.type === "function") return false;
  return node.type === "await" || Object.values(node).some(awaits);
}

// The first `wait for` outside a function or lambda. It needs module output, because
// JavaScript only allows a top-level await in a module.
function topLevelAwait(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = topLevelAwait(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || node.type === "lambda" || node.type === "function") return null;
  if (node.type === "await") return node;
  for (const value of Object.values(node)) {
    const found = topLevelAwait(value);
    if (found) return found;
  }
  return null;
}

export { awaits, topLevelAwait };
