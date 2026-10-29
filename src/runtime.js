// These helpers are also embedded in emitted JavaScript so compiled scripts are standalone.
export function __prose_chars(value, line) {
  if (typeof value !== "string") throw new TypeError(`Line ${line}: Expected a string.`);
  return [...value];
}

export function __prose_length(value, line) {
  if (Array.isArray(value)) return value.length;
  return __prose_chars(value, line).length;
}

export function __prose_get(value, index, line) {
  if (value === undefined) return undefined;
  const chars = Array.isArray(value) ? value : __prose_chars(value, line);
  if (!Number.isInteger(index) || index < 1 || index > chars.length) return undefined;
  return chars[index - 1];
}

export function __prose_set(value, index, replacement, line) {
  if (Array.isArray(value)) {
    if (!Number.isInteger(index) || index < 1 || index > value.length + 1) {
      throw new RangeError(`Line ${line}: Array writes must replace a position or append at length + 1; gaps are not allowed.`);
    }
    value[index - 1] = replacement;
    return value;
  }
  const chars = value === undefined ? [] : __prose_chars(value, line);
  if (!Number.isInteger(index) || index < 1 || index > chars.length + 1) {
    throw new RangeError(`Line ${line}: String writes must replace a position or append at length + 1; gaps are not allowed.`);
  }
  if (typeof replacement !== "string" || [...replacement].length !== 1) {
    throw new TypeError(`Line ${line}: Indexed string assignment currently requires exactly one Unicode code point.`);
  }
  chars[index - 1] = replacement;
  return chars.join("");
}

export function __prose_char_to_number(value, line) {
  const chars = __prose_chars(value, line);
  if (chars.length !== 1) throw new TypeError(`Line ${line}: char_to_number requires exactly one Unicode code point.`);
  return value.codePointAt(0);
}

export function __prose_number_to_char(value, line) {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    throw new RangeError(`Line ${line}: number_to_char requires an integer from 0 to 1114111.`);
  }
  return String.fromCodePoint(value);
}

export function __prose_mod(left, right, line) {
  if (typeof left !== "number" || typeof right !== "number") {
    throw new TypeError(`Line ${line}: mod requires numbers.`);
  }
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) {
    throw new RangeError(`Line ${line}: mod requires finite numbers and a nonzero divisor.`);
  }
  const remainder = left % right;
  if (remainder === 0) return 0;
  return (remainder < 0) !== (right < 0) ? remainder + right : remainder;
}

export function __prose_property(value, name, line) {
  if (value === undefined || value === null) {
    throw new TypeError(`Line ${line}: Can't read property '${name}' of ${value === null ? "null" : "unset"}.`);
  }
  return value[name];
}

export function __prose_property_ref(value, name, line) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`Line ${line}: Named property assignment requires an object.`);
  }
  return {
    get: () => __prose_property(value, name, line),
    set: replacement => {
      // __proto__ is an ordinary data property; other names keep JavaScript setters such as document.title.
      if (name === "__proto__") {
        Object.defineProperty(value, name, {
          value: replacement, writable: true, enumerable: true, configurable: true
        });
      } else {
        value[name] = replacement;
      }
      return replacement;
    }
  };
}

export function __prose_index_ref(parent, indexExpression, line) {
  const original = parent.get();
  const index = indexExpression();
  return {
    get: () => __prose_get(original, index, line),
    set: replacement => parent.set(__prose_set(original, index, replacement, line))
  };
}

export function __prose_call(value, args, line) {
  if (typeof value !== "function") throw new TypeError(`Line ${line}: Only functions can be called.`);
  return value(...args);
}

export function __prose_method(value, name, args, line) {
  const method = __prose_property(value, name, line);
  if (typeof method !== "function") throw new TypeError(`Line ${line}: '${name}' is not a function.`);
  return method.apply(value, args);
}

export function __prose_new(value, args, line) {
  if (typeof value !== "function") throw new TypeError(`Line ${line}: 'new' requires a class or constructor.`);
  return new value(...args);
}

// The maybe helpers give unset instead of failing when there is nothing to read or call.
export function __prose_maybe_property(value, name) {
  return value === undefined || value === null ? undefined : value[name];
}

export function __prose_maybe_get(value, index, line) {
  return value === undefined || value === null ? undefined : __prose_get(value, index(), line);
}

export function __prose_maybe_call(value, args, line) {
  return value === undefined || value === null ? undefined : __prose_call(value, args(), line);
}

export function __prose_maybe_method(value, name, args, line) {
  if (value === undefined || value === null || value[name] === undefined || value[name] === null) return undefined;
  return __prose_method(value, name, args(), line);
}

export function __prose_each(value, line) {
  if (value === undefined || value === null || typeof value[Symbol.iterator] !== "function") {
    throw new TypeError(`Line ${line}: 'for each' requires an array, string, or other collection.`);
  }
  return value;
}

// `is an object`: something with properties, not null, a list, or a function.
export function __prose_is_object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `fail`: a message becomes an Error; an Error (such as one caught by on error) is raised as it is.
export function __prose_error(reason) {
  return reason instanceof Error ? reason : new Error(String(reason));
}

const helpers = [
  __prose_chars, __prose_length, __prose_get, __prose_set,
  __prose_char_to_number, __prose_number_to_char, __prose_mod,
  __prose_property, __prose_property_ref, __prose_index_ref,
  __prose_call, __prose_method, __prose_new, __prose_maybe_property, __prose_maybe_get,
  __prose_maybe_call, __prose_maybe_method, __prose_each, __prose_is_object, __prose_error
];

export const runtimeHelpers = helpers.map(helper => helper.name);
export const runtimeSource = helpers.map(helper => helper.toString()).join("\n\n");
// The same helpers as one ES module, for bundlers that share them instead of embedding them per file.
export const runtimeModule = `${runtimeSource}\n\nexport { ${runtimeHelpers.join(", ")} };\n`;
