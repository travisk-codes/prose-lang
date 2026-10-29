// TypeScript's "implicitly has an 'any' type" errors. Untyped Prose is allowed to be untyped,
// so the checker drops these instead of reporting them.
export const implicitAnyCodes = new Set([7005, 7006, 7008, 7010, 7011, 7015, 7016, 7018, 7019, 7022, 7023, 7024, 7031, 7034, 7053]);

// TypeScript turns untyped values into unknown ones on their way through generic functions:
// Array.from on an untyped parameter gives unknown[], and new Set gives Set<unknown>. In
// Prose those are still untyped, so errors about using an unknown value aren't reported.
const unknownSource = /^(?:Argument of type 'unknown'|Type 'unknown'|'[^']+' is of type 'unknown'|Object is of type 'unknown')/;

/** Whether a TypeScript error (its code and flattened message) comes from untyped Prose. */
export function untypedError(code, message) {
  return implicitAnyCodes.has(code) || unknownSource.test(message);
}

// Typed declarations for the checking output (compile with `check: true`). That output is
// TypeScript written only to be type-checked, never run, so the runtime helpers it still
// calls are declared here instead of embedded.
export const checkPrelude = `type __ProseIsAny<T> = 0 extends 1 & T ? true : false;
type __ProseUntyped<T> = __ProseIsAny<T> extends true ? true : unknown extends T ? true : false;
// A dot whose name is also a visible variable picks a position in text and lists, and the
// property with that literal name on anything else.
type __ProseDotName<T, I> = __ProseUntyped<T> extends true ? string
  : T extends string | readonly unknown[]
    ? __ProseUntyped<I> extends true ? string : I extends number ? string : keyof T : keyof T;
type __ProseDotValue<T, I, K> = __ProseUntyped<T> extends true ? any
  : T extends string | readonly unknown[]
    ? __ProseUntyped<I> extends true ? any
      : I extends number ? T extends string ? string : T extends readonly (infer E)[] ? E : never
      : K extends keyof T ? T[K] : never
    : K extends keyof T ? T[K] : never;
// Lists that can't change (such as list parameters) can't be written through a dot.
type __ProseDotWrite<T, I> = __ProseUntyped<T> extends true ? string
  : T extends string ? __ProseUntyped<I> extends true ? string : I extends number ? string : never
  : T extends unknown[] ? __ProseDotName<T, I> : T extends readonly unknown[] ? never : keyof T;
// A name worked out in parentheses after a dot: a number is a position in text and lists.
type __ProseKey<T> = __ProseUntyped<T> extends true ? PropertyKey
  : T extends string | readonly unknown[] ? number | keyof T : keyof T;
type __ProseKeyWrite<T> = __ProseUntyped<T> extends true ? PropertyKey
  : T extends string ? number : T extends unknown[] ? number | keyof T : T extends readonly unknown[] ? never : keyof T;
type __ProseKeyValue<T, K> = __ProseUntyped<T> extends true ? any
  : T extends string | readonly unknown[]
    ? K extends number ? T extends string ? string : T extends readonly (infer E)[] ? E : never
      : K extends keyof T ? T[K] : never
    : K extends keyof T ? T[K] : never;

declare function __prose_dot<T, I, K extends __ProseDotName<T, I>>(value: T, index: I, name: K): __ProseDotValue<T, I, K>;
declare function __prose_maybe_dot<T, I, K extends __ProseDotName<NonNullable<T>, I>>(value: T, index: I, name: K):
  __ProseDotValue<NonNullable<T>, I, K> | undefined;
declare function __prose_dot_set<T, I, K extends __ProseDotWrite<T, I>>(value: T, index: I, name: K, item: __ProseDotValue<T, I, K>): void;
declare function __prose_dot_key<T, K extends __ProseKey<T>>(value: T, key: K): __ProseKeyValue<T, K>;
declare function __prose_maybe_dot_key<T, K extends __ProseKey<NonNullable<T>>>(value: T, key: K):
  __ProseKeyValue<NonNullable<T>, K> | undefined;
declare function __prose_dot_key_set<T, K extends __ProseKeyWrite<T>>(value: T, key: K, item: __ProseKeyValue<T, K>): void;
// A numbered position written with a literal, as in rows.2 is row.
declare function __prose_set_at<E>(value: E[], index: number, item: E): void;
declare function __prose_set_at(value: string | undefined, index: number, item: string): void;

declare function __prose_length(value: string | readonly unknown[], line: number): number;
declare function __prose_char_to_number(value: string, line: number): number;
declare function __prose_number_to_char(value: number, line: number): string;
declare function __prose_mod(left: number, right: number, line: number): number;
type __ProseItem<T> = __ProseIsAny<T> extends true ? any : T extends Iterable<infer E> ? E : never;
declare function __prose_each<T extends Iterable<unknown>>(value: T, line: number): Iterable<__ProseItem<T>>;
declare function __prose_is_object(value: unknown): value is { [key: string]: any };
// An unannotated object can gain fields after a function or constructor returns it.
// Existing fields keep their types; explicitly annotated bindings do not use this helper.
type __ProseOpen<T, K extends PropertyKey> = __ProseUntyped<T> extends true ? any
  : T extends object ? T & { [P in Exclude<K, keyof T>]?: any } : T;
declare function __prose_open<T, K extends PropertyKey>(value: T, ...keys: K[]): __ProseOpen<T, K>;
declare function __prose_error(reason: unknown): Error;
`;
