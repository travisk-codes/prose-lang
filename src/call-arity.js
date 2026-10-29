// Arity is syntax information, not a runtime function.length check. A binding
// may hold several implementations; only a common, provable count is inferred.
export function callScopeKey(node) {
  if (node?.callScopeKey) return node.callScopeKey;
  const at = node?.location ?? node?.source ?? node;
  return at ? `${at.line}:${at.start}` : "program";
}

const arityBottom = -1;
const joinArity = (left, right) => left === arityBottom ? right : right === arityBottom ? left : left === right ? left : null;

export function functionTypeArity(type, aliases = new Map(), seen = new Set()) {
  if (!type || seen.has(type)) return null;
  seen = new Set(seen).add(type);
  if (type.kind === "function") return type.params.length;
  if (type.kind === "maybe" || type.kind === "group") return functionTypeArity(type.of, aliases, seen);
  if (type.kind === "named" && aliases.has(type.name)) return functionTypeArity(aliases.get(type.name), aliases, seen);
  if (type.kind === "union") {
    const options = type.options.filter(part => !(part.kind === "builtin" && ["undefined", "null"].includes(part.name)));
    return options.length ? options.map(part => functionTypeArity(part, aliases, seen)).reduce(joinArity, arityBottom) : null;
  }
  return null;
}

export function inferCallArities(program, functions, imports = new Map(), invalidated = new Set()) {
  const aliases = new Map(program.filter(node => node.type === "typeDeclaration" && node.value).map(node => [node.name, node.value]));
  const scopes = new Map(), all = [];
  function scope(parent, key, params = [], types = []) {
    const current = { parent, key, bindings: new Map(), writes: new Map(), contracts: new Map() };
    current.lookup = name => {
      if (current.bindings.has(name)) return current.bindings.get(name);
      return parent ? parent.lookup(name) : functions.has(name) ? functions.get(name).params.length : null;
    };
    params.forEach((name, i) => {
      const count = functionTypeArity(types[i], aliases);
      current.bindings.set(name, count);
      if (count !== null) current.contracts.set(name, count);
    });
    scopes.set(key, current); all.push(current);
    return current;
  }
  const root = scope(null, "program");
  for (const [name, count] of imports) root.bindings.set(name, count);
  function scan(node, current) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(child => scan(child, current)); return; }
    if (node.type === "function" || node.type === "lambda") {
      const child = scope(current, callScopeKey(node), node.params, node.types);
      scan(node.body ?? node.value, child);
      return;
    }
    if (node.type === "assign") {
      if (!current.bindings.has(node.name)) current.bindings.set(node.name, arityBottom);
      if (!current.writes.has(node.name)) current.writes.set(node.name, []);
      current.writes.get(node.name).push(node.value);
      const count = functionTypeArity(node.declaredType, aliases);
      if (count !== null && !current.contracts.has(node.name)) current.contracts.set(node.name, count);
    }
    const dynamic = node.type === "for" ? [node.name]
      : ["foreach", "destructure"].includes(node.type) ? node.names : node.type === "try" && node.name ? [node.name] : [];
    for (const name of dynamic) current.bindings.set(name, null);
    for (const child of Object.values(node)) scan(child, current);
  }
  scan(program, root);
  const valueArity = (node, current) => {
    if (node.type === "lambda") return node.params.length;
    if (node.type === "name") return current.lookup(node.value);
    if (node.type === "unset" || node.type === "literal" && node.value === null) return arityBottom;
    if (node.type === "conditional") return joinArity(valueArity(node.then, current), valueArity(node.otherwise, current));
    return null;
  };
  for (const current of all) {
    for (const [name, count] of current.contracts) current.bindings.set(name, count);
    for (const name of current.bindings.keys()) if (invalidated.has(`${current.key}/${name}`)) current.bindings.set(name, null);
  }
  let changed;
  do {
    changed = false;
    for (const current of all) for (const [name, values] of current.writes) {
      if (current.contracts.has(name) || invalidated.has(`${current.key}/${name}`)) continue;
      const before = current.bindings.get(name);
      const after = values.reduce((count, node) => joinArity(count, valueArity(node, current)), before);
      if (after !== before) { current.bindings.set(name, after); changed = true; }
    }
  } while (changed);
  for (const current of all) for (const [name, count] of current.bindings) if (count === arityBottom) current.bindings.set(name, null);
  const fingerprint = JSON.stringify(all.map(current => [current.key, current.parent?.key,
    [...current.bindings].sort(([a], [b]) => a.localeCompare(b))]).sort(([a], [b]) => a.localeCompare(b)));
  return { root, scopes, fingerprint };
}
