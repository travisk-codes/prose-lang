// Arity is syntax information, not a runtime function.length check. A binding
// may hold several implementations; only a common, provable count is inferred.
import { objectCallArities } from "./object-call-arity.js";

export function callScopeKey(node) {
  if (node?.callScopeKey) return node.callScopeKey;
  const at = node?.location ?? node?.source ?? node;
  return at ? `${at.line}:${at.start}` : "program";
}

export function propertyCallKey(node) {
  const at = node.memberLocation ?? node.location;
  return at ? `property:${at.line}:${at.start}` : null;
}

const arityBottom = -1;
const joinArity = (left, right) => left === arityBottom ? right : right === arityBottom ? left : left === right ? left : null;

// Fixed standard collection signatures. Optional/rest signatures (forEach,
// constructors, etc.) deliberately stay unknown; a runtime .length is not a
// reliable argument boundary. Keep this pass independent of TypeScript.
const collectionMethods = new Map([
  ["Map", new Map(Object.entries({ get: 1, set: 2, has: 1, delete: 1, clear: 0, keys: 0, values: 0, entries: 0 }))],
  ["Set", new Map(Object.entries({ add: 1, has: 1, delete: 1, clear: 0, keys: 0, values: 0, entries: 0 }))],
  ["WeakMap", new Map(Object.entries({ get: 1, set: 2, has: 1, delete: 1 }))],
  ["WeakSet", new Map(Object.entries({ add: 1, has: 1, delete: 1 }))]
]);
const propertyName = node => node.name ?? (node.key?.type === "literal" && typeof node.key.value === "string" ? node.key.value : null);

function collectionType(type, aliases, seen = new Set()) {
  if (!type || seen.has(type)) return null;
  seen = new Set(seen).add(type);
  if (type.kind === "map") return "Map";
  if (type.kind === "set") return "Set";
  if (type.kind === "maybe" || type.kind === "group") return collectionType(type.of, aliases, seen);
  if (type.kind === "named") return aliases.has(type.name) ? collectionType(aliases.get(type.name), aliases, seen)
    : collectionMethods.has(type.name) ? type.name : null;
  if (type.kind === "union") {
    const options = type.options.filter(part => !(part.kind === "builtin" && ["undefined", "null"].includes(part.name)));
    return options.length ? options.map(part => collectionType(part, aliases, seen)).reduce(joinArity, arityBottom) : null;
  }
  return null;
}

function collectionResultType(type, aliases, seen = new Set()) {
  if (!type || seen.has(type)) return null;
  seen = new Set(seen).add(type);
  if (type.kind === "function") return collectionType(type.returns, aliases);
  if (type.kind === "maybe" || type.kind === "group") return collectionResultType(type.of, aliases, seen);
  if (type.kind === "named" && aliases.has(type.name)) return collectionResultType(aliases.get(type.name), aliases, seen);
  if (type.kind === "union") return type.options.map(part => collectionResultType(part, aliases, seen)).reduce(joinArity, arityBottom);
  return null;
}

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

export function inferCallArities(program, functions, imports = new Map(), invalidated = new Set(), normalize = name => name, valueSignatures = new Map(), lazyImports = false) {
  const aliases = new Map(program.filter(node => node.type === "typeDeclaration").map(node => [node.name, node.value]));
  const scopes = new Map(), all = [], mutations = [], blockedMethods = new Map(), properties = [];
  function scope(parent, key, params = [], types = []) {
    const current = { parent, key, bindings: new Map(), writes: new Map(), contracts: new Map(), kinds: new Map(), kindContracts: new Map(), resultContracts: new Map(), valueTypes: new Map(params.map((name, i) => [name, types[i]])), dynamicBindings: new Set() };
    current.lookup = name => {
      if (current.bindings.has(name)) return current.bindings.get(name);
      return parent ? parent.lookup(name) : functions.has(name) ? functions.get(name).params.length : null;
    };
    current.hasBinding = name => current.bindings.has(name) || (parent?.hasBinding(name) ?? false);
    current.lookupKind = name => current.kinds.has(name) ? current.kinds.get(name) : parent?.lookupKind(name) ?? null;
    current.constructorKind = node => node.type === "name" && collectionMethods.has(node.value) && !current.hasBinding(node.value) && !functions.has(node.value) ? node.value : null;
    current.methodArity = node => {
      if (node.type !== "property") return null;
      if (invalidated.has(propertyCallKey(node))) return null;
      const kind = valueKind(node.object, current), name = propertyName(node);
      if (blockedMethods.get(kind)?.has(name) || blockedMethods.get(kind)?.has("*")) return null;
      return collectionMethods.get(kind)?.get(name) ?? objects.arity(node, current);
    };
    params.forEach((name, i) => {
      const count = functionTypeArity(types[i], aliases);
      current.bindings.set(name, count);
      if (count !== null) current.contracts.set(name, count);
      const kind = collectionType(types[i], aliases);
      current.kinds.set(name, kind);
      if (kind !== null) current.kindContracts.set(name, kind);
      const result = collectionResultType(types[i], aliases);
      if (result !== null) current.resultContracts.set(name, result);
    });
    scopes.set(key, current); all.push(current);
    return current;
  }
  const root = scope(null, "program");
  for (const [name, count] of imports) { root.bindings.set(name, count); root.kinds.set(name, null); }
  function scan(node, current) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(child => scan(child, current)); return; }
    if (node.type === "function" || node.type === "lambda") {
      const child = scope(current, callScopeKey(node), node.params, node.types);
      scan(node.body ?? node.value, child);
      return;
    }
    if (node.type === "assign") {
      if (node.declaredType && !current.valueTypes.get(node.name)) current.valueTypes.set(node.name, node.declaredType);
      if (!current.bindings.has(node.name)) current.bindings.set(node.name, arityBottom);
      if (!current.kinds.has(node.name)) current.kinds.set(node.name, arityBottom);
      if (!current.writes.has(node.name)) current.writes.set(node.name, []);
      current.writes.get(node.name).push(node.value);
      const count = functionTypeArity(node.declaredType, aliases);
      if (count !== null && !current.contracts.has(node.name)) current.contracts.set(node.name, count);
      const kind = collectionType(node.declaredType, aliases);
      if (kind !== null && !current.kindContracts.has(node.name)) current.kindContracts.set(node.name, kind);
      const result = collectionResultType(node.declaredType, aliases);
      if (result !== null && !current.resultContracts.has(node.name)) current.resultContracts.set(node.name, result);
    }
    if (node.type === "assignTarget" && node.target.type === "property") mutations.push([node.target, current]);
    if (node.type === "property") properties.push([node, current]);
    const dynamic = node.type === "for" ? [node.name]
      : ["foreach", "destructure"].includes(node.type) ? node.names : node.type === "try" && node.name ? [node.name] : [];
    for (const name of dynamic) { current.bindings.set(name, null); current.kinds.set(name, null); current.dynamicBindings.add(name); }
    for (const child of Object.values(node)) scan(child, current);
  }
  scan(program, root);
  const valueArity = (node, current) => {
    if (node.type === "lambda") return node.params.length;
    if (node.type === "name") return current.lookup(node.value);
    if (node.type === "property") return current.methodArity(node);
    if (node.type === "unset" || node.type === "literal" && node.value === null) return arityBottom;
    if (node.type === "conditional") return joinArity(valueArity(node.then, current), valueArity(node.otherwise, current));
    return null;
  };
  const valueKind = (node, current) => {
    if (node.type === "name") return current.lookupKind(node.value);
    if (node.type === "new") return current.constructorKind(node.callee);
    if (node.type === "unset" || node.type === "literal" && node.value === null) return arityBottom;
    if (node.type === "conditional") return joinArity(valueKind(node.then, current), valueKind(node.otherwise, current));
    if (node.type === "property" && propertyName(node) === "prototype") return current.constructorKind(node.object);
    if (node.type === "invoke") return resultKind(node.callee, current);
    if (node.type === "call") return resultKind({ type: "name", value: node.name }, current);
    return null;
  };
  function resultKind(node, current, seen = new Set()) {
    if (node.type === "lambda") return collectionType(node.returns, aliases);
    if (node.type === "name") {
      if (!current.bindings.has(node.value)) return current.parent ? resultKind(node, current.parent, seen) : collectionType(functions.get(node.value)?.returns, aliases);
      if (current.resultContracts.has(node.value)) return current.resultContracts.get(node.value);
      const key = `${current.key}/${node.value}`;
      if (seen.has(key)) return null;
      seen = new Set(seen).add(key);
      const values = current.writes.get(node.value);
      return values?.length ? values.map(value => resultKind(value, current, seen)).reduce(joinArity, arityBottom) : null;
    }
    if (node.type === "conditional") return joinArity(resultKind(node.then, current, seen), resultKind(node.otherwise, current, seen));
    // Collection setters return their receiver. Map.get can contain anything.
    if (node.type === "property" && ["set", "add"].includes(propertyName(node)) && current.methodArity(node) !== null) return valueKind(node.object, current);
    if (node.type === "unset" || node.type === "literal" && node.value === null) return arityBottom;
    return null;
  }
  // Follow every possible collection assignment when looking for method writes,
  // even when another assignment makes the binding's exact kind unknown. Writes
  // through aliases, or to a prototype, conservatively disable that signature
  // for the collection kind throughout this program.
  function possibleKinds(node, current, seen = new Set()) {
    const result = new Set(), kind = valueKind(node, current);
    if (collectionMethods.has(kind)) result.add(kind);
    if (node.type === "name") {
      if (!current.kinds.has(node.value)) return current.parent ? possibleKinds(node, current.parent, seen) : result;
      const key = `${current.key}/${node.value}`;
      if (seen.has(key)) return result;
      seen = new Set(seen).add(key);
      const contract = current.kindContracts.get(node.value);
      if (contract) result.add(contract);
      for (const value of current.writes.get(node.value) ?? []) for (const candidate of possibleKinds(value, current, seen)) result.add(candidate);
    } else if (node.type === "conditional") {
      for (const part of [node.then, node.otherwise]) for (const candidate of possibleKinds(part, current, seen)) result.add(candidate);
    }
    return result;
  }
  const objects = objectCallArities(program, root, scopes, functions, functionTypeArity, normalize, valueSignatures, lazyImports);
  for (const current of all) {
    for (const [name, count] of current.contracts) current.bindings.set(name, count);
    for (const name of current.bindings.keys()) if (invalidated.has(`${current.key}/${name}`)) current.bindings.set(name, null);
    for (const [name, kind] of current.kindContracts) current.kinds.set(name, kind);
    for (const name of current.kinds.keys()) if (invalidated.has(`kind:${current.key}/${name}`)) current.kinds.set(name, null);
  }
  let changed;
  do {
    changed = false;
    for (const current of all) for (const [name, values] of current.writes) {
      if (!current.contracts.has(name) && !invalidated.has(`${current.key}/${name}`)) {
        const before = current.bindings.get(name);
        const after = values.reduce((count, node) => joinArity(count, valueArity(node, current)), before);
        if (after !== before) { current.bindings.set(name, after); changed = true; }
      }
      if (!current.kindContracts.has(name) && !invalidated.has(`kind:${current.key}/${name}`)) {
        const before = current.kinds.get(name);
        const after = values.reduce((kind, node) => joinArity(kind, valueKind(node, current)), before);
        if (after !== before) { current.kinds.set(name, after); changed = true; }
      }
    }
    for (const [target, current] of mutations) {
      const prototype = propertyName(target) === "prototype" && current.constructorKind(target.object);
      const kinds = prototype ? [prototype] : possibleKinds(target.object, current);
      for (const kind of kinds) {
        if (!blockedMethods.has(kind)) blockedMethods.set(kind, new Set());
        const blocked = blockedMethods.get(kind), name = prototype ? "*" : propertyName(target) ?? "*";
        if (!blocked.has(name)) { blocked.add(name); changed = true; }
      }
    }
  } while (changed);
  for (const current of all) for (const [name, count] of current.bindings) if (count === arityBottom) current.bindings.set(name, null);
  for (const current of all) for (const [name, kind] of current.kinds) if (kind === arityBottom) current.kinds.set(name, null);
  const sorted = entries => [...entries].sort(([a], [b]) => a.localeCompare(b));
  const propertyArities = new Map(properties.map(([node, current]) => [propertyCallKey(node), current.methodArity(node)]).filter(([key]) => key !== null));
  const fingerprint = JSON.stringify([all.map(current => [current.key, current.parent?.key, sorted(current.bindings), sorted(current.kinds)])
    .sort(([a], [b]) => a.localeCompare(b)), sorted(blockedMethods).map(([kind, names]) => [kind, [...names].sort()]), sorted(propertyArities)]);
  return { root, scopes, fingerprint, propertyArities, valueSignatures: names => objects.signatures(names) };
}
