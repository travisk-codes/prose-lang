// Prose names are snake_case; JavaScript names are camelCase.
// Prose names are snake_case and JavaScript's are camelCase, so a name of lowercase words joined
// by underscores (same_tag_name, to_locale_lower_case) is camelCase wherever JavaScript sees it.
const snakeName = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const plainCamel = name => name.replace(/_([a-z0-9])/g, (all, letter) => letter.toUpperCase());
// JavaScript's own names that capitalize a whole acronym, by how their words would otherwise join.
const acronymNames = new Map([
  "randomUUID", "toISOString", "toUTCString", "getUTCFullYear", "getUTCMonth", "getUTCDate",
  "getUTCDay", "getUTCHours", "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds",
  "setUTCFullYear", "setUTCMonth", "setUTCDate", "setUTCHours", "setUTCMinutes", "setUTCSeconds",
  "setUTCMilliseconds", "innerHTML", "outerHTML", "insertAdjacentHTML", "createObjectURL",
  "revokeObjectURL", "readAsDataURL", "toDataURL", "encodeURI", "decodeURI", "encodeURIComponent",
  "decodeURIComponent", "toJSON", "baseURI", "documentURI", "responseURL", "responseXML", "indexedDB"
].map(name => [plainCamel(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase()), name]));

export function camel(name) {
  if (!snakeName.test(name)) return name;
  const plain = plainCamel(name);
  return acronymNames.get(plain) ?? plain;
}

/** The JavaScript binding used for a Prose name. */
export const variable = name => `_prose_${name}`;


