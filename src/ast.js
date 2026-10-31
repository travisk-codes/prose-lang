// AST metadata helpers. Locations stay non-enumerable so syntax comparisons
// used by the formatter and signature discovery never see them.
// Locations are metadata, excluded from syntax comparisons used by the formatter.
function located(node, token) {
  if (token?.source) Object.defineProperty(node, "location", { value: token.source, configurable: true });
  return node;
}

// Keep each accessor's identity when a surrounding call or grouping gets its
// own location. Signature discovery must withdraw the same proof on reparse.
function memberLocated(node, token) {
  if (token?.source) Object.defineProperty(node, "memberLocation", { value: token.source });
  return node;
}


export { located, memberLocated };
