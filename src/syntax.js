// Syntax words shared by the parser and the emitter.
const reserved = new Set([
  "if", "else", "for", "is", "to", "print", "and", "or", "not",
  "true", "false", "null", "remainder", "function", "return", "while",
  "async", "await", "takes", "run", "mod", "object", "array",
  "with", "new", "each", "in", "then", "use", "export", "unset", "otherwise", "maybe",
  "as", "giving", "are", "skip", "stop", "try", "fail", "xor"
]);


// The kinds of value `is a` can test for, besides classes such as Error.
const typeTests = {
  text: value => `typeof ${value} === "string"`,
  number: value => `typeof ${value} === "number"`,
  boolean: value => `typeof ${value} === "boolean"`,
  function: value => `typeof ${value} === "function"`,
  list: value => `Array.isArray(${value})`,
  object: value => `__prose_is_object(${value})`
};


const isWord = (token, value) => token?.type === "word" && token.value === value;


export { reserved, typeTests, isWord };
