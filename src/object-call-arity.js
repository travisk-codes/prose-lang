// Resolve local object properties without executing a program or loading TS.
// Object literals retain their identity so writes through aliases contribute
// to the same property. Every locally resolved assignment must agree on count.
export function objectCallArities(program, root, scopes, functions, functionTypeArity, normalize, imports = new Map(), lazyImports = false) {
  const unknown = {}, missing = {}, absent = {};
  const definitions = new Map(program.filter(node => node.type === "typeDeclaration").map(node => [node.name, node]));
  const declarations = new Map(program.filter(node => node.type === "function").map(node => [node.name, node]));
  const aliases = new Map([...definitions].map(([name, node]) => [name, node.value]));
  const sources = new WeakMap(), typed = new WeakMap(), imported = new Map(), writes = new Map(), mutations = [], external = new WeakMap();
  let importsEnabled = !lazyImports, revision = 0;
  const unique = values => [...new Set(values)];
  const keyOf = node => node.name !== undefined ? normalize(node.name)
    : node.key?.type === "literal" && typeof node.key.value === "string" ? node.key.value : null;
  const step = (reference, part) => reference && { ...reference, steps: [...(reference.steps ?? []), part] };
  function importedValues(supplied, reference, seen = new Set()) {
    if (typeof supplied === "function") {
      if (!importsEnabled) return [unknown];
      supplied = supplied();
    }
    if (!Array.isArray(supplied)) { reference = supplied.reference ?? reference; supplied = supplied.values; }
    return supplied.map(signature => {
      if (signature.kind === "unknown") return unknown;
      if (signature.kind === "absent") return absent;
      const identity = signature.identity ?? signature;
      if (!external.has(identity)) external.set(identity, { signature, views: new Set(), reference });
      const value = external.get(identity);
      if (!value.reference && reference) value.reference = reference;
      if (!value.views.has(signature)) { value.views.add(signature); revision++; }
      if (!seen.has(signature)) {
        const visited = new Set(seen).add(signature);
        signature.properties?.forEach((parts, key) => importedValues(parts, step(reference, { property: key }), visited));
        if (signature.returns) importedValues(signature.returns, step(reference, { returns: true }), visited);
      }
      return value;
    });
  }
  // Share descriptor identities across exported aliases and separate use lines.
  for (const signatures of imports.values()) importedValues(signatures);
  function source(node, current) {
    if (!sources.has(node)) sources.set(node, { node, current });
    return sources.get(node);
  }
  function typeValues(type, seen = new Set()) {
    if (!type || seen.has(type)) return [unknown];
    seen = new Set(seen).add(type);
    if (type.kind === "group") return typeValues(type.of, seen);
    if (type.kind === "maybe") return unique([absent, ...typeValues(type.of, seen)]);
    if (type.kind === "union") return unique(type.options.flatMap(part => typeValues(part, seen)));
    if (type.kind === "builtin" && ["undefined", "null"].includes(type.name)) return [absent];
    if (type.kind === "named" && definitions.has(type.name)) {
      const definition = definitions.get(type.name);
      if (!definition.fields) return typeValues(definition.value, seen);
      type = definition;
    } else if (type.kind !== "function") return [unknown];
    if (!typed.has(type)) typed.set(type, { type });
    return [typed.get(type)];
  }
  function owner(current, name) {
    while (current && !current.bindings.has(name)) current = current.parent;
    return current;
  }
  function values(node, current, depth = 0, seen = new Set()) {
    if (!node || depth > 64) return [unknown];
    if (node.type === "unset" || node.type === "literal" && node.value === null) return [absent];
    if (node.type === "object" || node.type === "lambda") return [source(node, current)];
    if (node.type === "conditional") return unique([node.then, node.otherwise].flatMap(part => values(part, current, depth + 1, seen)));
    if (node.type === "name") {
      const binding = owner(current, node.value);
      if (!binding) return imports.has(node.value) ? importedValues(imports.get(node.value))
        : functions.has(node.value) ? [source(functions.get(node.value), root)] : [unknown];
      const key = `${binding.key}/${node.value}`;
      if (seen.has(key)) return [unknown];
      seen = new Set(seen).add(key);
      const contract = typeValues(binding.valueTypes.get(node.value));
      const dynamic = binding.dynamicBindings.has(node.value);
      if (binding.contracts.has(node.value) && !dynamic) return contract;
      const assignments = binding.writes.get(node.value);
      if (!assignments?.length) {
        if (contract.some(value => value.type)) return dynamic ? [unknown, ...contract] : contract;
        if (binding === root && imports.has(node.value)) {
          const supplied = importedValues(imports.get(node.value));
          return dynamic ? [unknown, ...supplied] : supplied;
        }
        if (!imported.has(key)) imported.set(key, { binding, name: node.value });
        return [imported.get(key)];
      }
      const possible = assignments.flatMap(value => values(value, binding, depth + 1, seen));
      if (binding === root && imports.has(node.value)) possible.push(...importedValues(imports.get(node.value)));
      if (dynamic) possible.push(unknown);
      return unique(possible.flatMap(value => !dynamic && (value === unknown || value === absent) && contract.some(item => item.type) ? contract : [value]));
    }
    if (node.type === "property") {
      const key = keyOf(node);
      return key === null ? [unknown] : unique(values(node.object, current, depth + 1, seen).flatMap(value => property(value, key, depth + 1)));
    }
    if (node.type === "invoke" || node.type === "call") {
      const callee = node.callee ?? { type: "name", value: node.name };
      return unique(values(callee, current, depth + 1, seen).flatMap(value => {
        const count = arityOf(value);
        // A shallow export parse may have collected commas before an imported
        // count was available. Extra values could really be array elements.
        if (count !== null && count >= 0 && node.args.length > count) return [unknown];
        return value.signature ? importedValues(value.signature.returns ?? [{ kind: "unknown" }], step(value.reference, { returns: true }))
          : typeValues(value.node?.returns ?? value.type?.returns);
      }));
    }
    return [unknown];
  }
  function property(value, key, depth = 0) {
    if (value === absent) return [absent];
    if (depth > 64 || value === unknown || value === missing) return [unknown];
    let result = [missing];
    if (value.node?.type === "object") {
      for (const entry of value.node.properties) {
        if (entry.spread) {
          const fallback = result;
          result = unique(values(entry.value, value.current, depth + 1).flatMap(spread =>
            property(spread, key, depth + 1).flatMap(part => part === missing || part === absent ? fallback : [part])));
        } else if (normalize(entry.name) === key) result = values(entry.value, value.current, depth + 1);
      }
    } else if (value.signature?.kind === "object") {
      result = unique([...value.views].flatMap(view => view.properties.has(key)
        ? importedValues(view.properties.get(key), step(value.reference, { property: key })) : [view.open ? unknown : missing]));
    } else if (value.type?.fields) {
      const field = value.type.fields.find(field => normalize(field.name) === key);
      if (field) result = typeValues(field.type);
    } else return [unknown];
    const changes = writes.get(value);
    if (changes?.has("*")) return [unknown];
    if (changes?.has(key)) result = unique([
      ...result.filter(part => part !== missing),
      ...[...changes.get(key)].flatMap(change => values(change.value, change.current, depth + 1))
    ]);
    return result;
  }
  function visit(node, current) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(child => visit(child, current)); return; }
    if (node.type === "function" || node.type === "lambda") {
      const child = scopes.get(node.callScopeKey ?? `${node.location?.line}:${node.location?.start}`);
      visit(node.body ?? node.value, child ?? current);
      return;
    }
    if (node.type === "assignTarget" && node.target.type === "property") mutations.push({ target: node.target, value: node.value, current });
    for (const child of Object.values(node)) visit(child, current);
  }
  visit(program, root);
  // Property writes can reveal further objects, such as holder.child = object.
  // Grow the possible targets until every alias and nested write is accounted
  // for. Each pair of a mutation and an object is added at most once.
  function resolveMutations() {
    let changed;
    do {
      changed = false;
      for (const mutation of mutations) for (const value of values(mutation.target.object, mutation.current)) {
        if (value.node?.type !== "object" && !value.type?.fields && value.signature?.kind !== "object") continue;
        if (!writes.has(value)) writes.set(value, new Map());
        const properties = writes.get(value), key = keyOf(mutation.target) ?? "*";
        if (!properties.has(key)) properties.set(key, new Set());
        if (!properties.get(key).has(mutation)) { properties.get(key).add(mutation); changed = true; }
      }
    } while (changed);
  }
  resolveMutations();
  function arityOf(value) {
    return value.node?.params?.length ?? (value.type ? functionTypeArity(value.type, aliases)
      : value.binding ? value.binding.lookup(value.name) : value.signature?.arity ?? null);
  }
  // Export a graph of syntax-only signatures, retaining shared/nested object
  // identities. A missing proof stays unknown, including opaque import values.
  const described = new Map();
  function keys(value, seen = new Set()) {
    if (seen.has(value)) return { names: new Set(), open: false };
    seen = new Set(seen).add(value);
    const names = new Set(), changes = writes.get(value);
    let open = changes?.has("*") ?? false;
    if (value.node?.type === "object") {
      for (const entry of value.node.properties) {
        if (!entry.spread) names.add(normalize(entry.name));
        else for (const spread of values(entry.value, value.current)) {
          const info = keys(spread, seen);
          info.names.forEach(name => names.add(name)); open ||= info.open;
        }
      }
    } else if (value.type?.fields) value.type.fields.forEach(field => names.add(normalize(field.name)));
    else if (value.signature?.kind === "object") {
      for (const view of value.views) { view.properties.forEach((_, name) => names.add(name)); open ||= view.open; }
    } else open = value !== absent;
    changes?.forEach((_, name) => { if (name !== "*") names.add(name); });
    return { names, open };
  }
  function describe(value) {
    if (value === unknown || value === missing) return { kind: "unknown" };
    if (value === absent) return { kind: "absent" };
    if (described.has(value)) return described.get(value);
    const object = value.node?.type === "object" || value.type?.fields || value.signature?.kind === "object";
    const arity = arityOf(value);
    const result = object ? { kind: "object", properties: new Map(), open: false }
      : arity !== null && arity >= 0 ? { kind: "function", arity } : { kind: "unknown" };
    if (result.kind !== "unknown") result.identity = value.signature?.identity ?? value.signature ?? value;
    if (value.reference) result.reference = value.reference;
    described.set(value, result);
    if (object) {
      const info = keys(value); result.open = info.open;
      for (const name of info.names) result.properties.set(name, property(value, name).map(describe));
    } else if (result.kind === "function") {
      if (value.node) result.callable = declarations.get(value.node.name) ?? value.node;
      if (value.type?.kind === "function") result.functionType = value.type;
      result.returns = value.signature ? (value.signature.returns ?? [{ kind: "unknown" }])
        : typeValues(value.node?.returns ?? value.type?.returns).map(describe);
    }
    return result;
  }
  return {
    signatures(names) {
      importsEnabled = true;
      const entries = [...names];
      // Export-only discovery resolves imports when their values are needed,
      // rather than reading dependencies used only inside unrelated functions.
      let result, before;
      do {
        before = revision;
        resolveMutations(); described.clear();
        result = new Map(entries.map(name => [name, values({ type: "name", value: name }, root).map(describe)]));
      } while (before !== revision);
      return result;
    },
    arity(node, current) {
      const possible = values(node, current);
      let count;
      for (const value of possible) {
        if (value === absent) continue;
        const next = arityOf(value);
        if (next === null || next < 0 || next === undefined || count !== undefined && next !== count) return null;
        count = next;
      }
      return count ?? null;
    }
  };
}
