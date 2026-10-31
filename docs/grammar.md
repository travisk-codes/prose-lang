# Prose grammar

Status: descriptive reference for Prose **0.2.3**, derived from the implementation in
[`src/lexer.js`](../src/lexer.js), [`src/layout.js`](../src/layout.js),
[`src/expression.js`](../src/expression.js), [`src/parser.js`](../src/parser.js),
[`src/transpile.js`](../src/transpile.js), [`src/markup.js`](../src/markup.js), and
[`src/call-arity.js`](../src/call-arity.js).
Where this document and the [README](../README.md) disagree, the code is
authoritative. Nothing here is a change proposal.

## 1. The grammar has four layers

Prose cannot be described by a single context-free grammar. It is described here as:

| Layer | Concern | Implementation |
| --- | --- | --- |
| **Lexical** | tokens, contextual `pattern` and markup | `tokenize`, `lexSource` |
| **Layout** | indentation, continuation lines, blocks | `sourceLines`, `continues` |
| **Phrase grammar `G(Γ)`** | statements, expressions, types | `Parser`, `Expression` |
| **Static semantics** | scopes, name resolution, call arities | `resolve`, `discoverCallArities`, `call-arity.js` |

`Γ` is the **arity environment**: a partial map from callable bindings to argument
counts. `G(Γ)` is the part of the grammar that looks context-free once `Γ` is known.
Section 7 explains why this decomposition is necessary.

Notation: `X?` optional, `X*` zero or more, `X+` one or more, `|` alternatives,
`'...'` literal tokens, uppercase names for token classes. `NEWLINE`, `INDENT`, and
`DEDENT` are layout tokens, not characters. Comments are `(* ... *)`.

## 2. Source text

```text
source      ::= BOM? physical-line ( NEWLINE physical-line )* NEWLINE?
physical-line ::= ( SPACE | TAB )* content ( '\r' )?
```

- Lines end with LF or CRLF. A trailing CR is removed before tokenizing.
- A leading BOM is removed at the start of the source (and of the first line).
- Indentation is measured in columns: a space is one column, a tab is four.
- Blank lines (only spaces/tabs) produce no tokens and have no grammatical effect.
- A physical line is never a statement by itself: layout joins some physical lines
  into one **logical line**, and a statement is parsed from a logical line plus,
  where a block follows, its indented lines.
- Text inside strings, regexes, and markup text may contain characters that are
  otherwise punctuation.

## 3. Layout

### 3.1 Logical lines

A physical line continues the previous logical line when any of the following holds:

1. the previous logical line has an unclosed `(`;
2. its last token is a **continuation symbol**:
   `, + - * / % = != < > <= >=`;
3. its last token is a **continuation word**:
   `and or otherwise mod xor is are with giving of by return takes`, and the token
   before it is not `.` or `:` (so a property named `is` or `and` ends the line);
4. its last token is `if` or `else`, and the token before it is not `.` or `:`;
5. it is a **leading condition line**: it starts with `and` or `or`, is indented at
   least as far as the previous line, and the previous line is an `if`, `else if`,
   or `while` header, or a pending conditional value;
6. it is an **indented conditional-value line**: it starts with `if` (not followed by
   `is` or `as`), is indented deeper than the previous line, and the previous line
   ends a value that can take a trailing conditional;
7. it is the matching `else` of such a conditional value;
8. it is a `giving` line at the **same** indentation as a wrapped function header.

Otherwise it starts a new logical line.

Ordinary continuations (rules 1-4) must be indented **more** than the first physical
line of their logical line. Two exceptions: a leading `and`/`or` line may align with
its header or be deeper (rule 5), and a `giving` line may sit at the header's
indentation (rule 8). A conditional value's `if`/`else` lines (rules 6-7) are deeper
than the expression they continue.

### 3.2 Blocks

```text
block   ::= NEWLINE INDENT statement+ DEDENT
```

- The first line of a body sets its indentation; every sibling statement must use
  exactly that indentation.
- A body must be indented more than its header.
- Blank lines are ignored, including inside blocks.
- A dedent ends the block; dedenting to a column that is not an enclosing block's
  indentation is an error (`Unexpected indentation`).
- Object bodies and type bodies use the same rule.

### 3.3 Inline versus block bodies

`if`, `else if`, and `else` accept either an indented body or one simple statement on
the same logical line. Every other block form (`function`, `while`, `for`,
`for each`, `try`, `on error`, `type`, `object` bodies) requires an indented body.
A `then` at the end of an `if` line introduces the indented body instead of an inline
statement.

### 3.4 Documentation comments

A logical line containing exactly one `STRING` token is a **comment**. Consecutive
comment lines immediately above a top-level declaration (and immediately above a
field in a type body) are joined with single spaces and become the declaration's
documentation comment in generated `.d.prose.ts` files; a blank line breaks the
chain. Elsewhere each comment is an ordinary expression statement whose string value
is discarded.

## 4. Lexical grammar

```text
NAME        ::= [A-Za-z_] [A-Za-z_0-9]*
WORD        ::= [A-Za-z_] [A-Za-z_0-9]*        (* NAME or a reserved/contextual word *)
NUMBER      ::= [0-9]+ ( '.' [0-9]+ )?
STRING      ::= '"' ( escape | ~[ " \\ \n ] )* '"'
escape      ::= '\' ( '"' | '\' | '/' | 'b' | 'f' | 'n' | 'r' | 't'
                    | 'u' hex hex hex hex )
SYMBOL      ::= '<=' | '>=' | '!=' | '=' | '<' | '>' | '+' | '-'
              | '*' | '/' | '%' | '(' | ')' | '.' | ',' | ':'
PATTERN     ::= 'pattern' STRING            (* contextual, see 4.3 *)
MARKUP      ::= element                     (* contextual, see 4.4 *)
```

- **Maximal munch.** `<=`, `>=`, and `!=` are single tokens; `1.2` is one NUMBER.
  `1.2.3` is NUMBER(`1.2`) then `.` then NUMBER(`3`), which is why `rows.1.2` is an
  index of `1.2`, not two indexes.
- **No other operators.** A lone `!`, `==`, `&&`, `||`, `**`, `?`, `[`, `]`, `{`
  (outside markup), `|`, `&`, `~`, `;`, `#`, or `'` (outside markup) fails with
  `Unexpected character`.
- **Numbers** are decimal, unsigned at the token level, and have no exponent,
  hexadecimal, binary, separator, or leading `.`. A number that is not finite after
  conversion is an error.
- **Strings** are single-line JSON-style strings; escapes are decoded with
  `JSON.parse`, so invalid escapes are errors and a raw newline is unterminated.
  There are no single-quoted, raw, template, or multiline strings.
- **Comments** are not lexical: they are standalone string expressions (3.4).
- **Identifiers are ASCII.** Unicode is allowed inside strings and markup text, not
  in names.

### 4.1 Words and the reserved set

Keywords are word tokens, not a distinct token class. The reserved words, which
cannot be used where a `NAME` is required, are:

```text
if else for is to print and or not true false null remainder function
return while async await takes run mod object array with new each in
then use export unset otherwise maybe as giving are skip stop try fail xor
```

`async` and `await` are reserved but unsupported (the program fails with a
"not supported yet" message); the language spells waiting as `wait for`.

These words are **not** reserved and may be ordinary names: `type`, `from`, `like`,
`shifted`, `taking`, `everywhere`, `ignoring`, `case`, `by`, `line`, `a`, `an`,
`of`. Several of them are contextual keywords in specific positions. Property names
after `.` or `:` and object entry names may be reserved words
(`record:class`, `x.print`).

### 4.2 Spacing and minus

The lexer records whether whitespace preceded each token, and one rule depends on it.
When the callee is a **property, method, or unknown-arity value**, a following `-` is
ambiguous: `f - 1` subtracts (spaces on both sides), `f-1` subtracts, and `f -1`
(space before, none after) is rejected with a message asking for `f (-1)` or
`f with -1`. When the callee is a **known-arity function name with at least one
parameter**, the `-` is the first argument's sign instead: `f - 1`, `f -1`, and
`f-1` all mean `f(-1)`. To subtract from the result of such a call, write
`(f 1) - 1`. A zero-parameter function name behaves like a value, so `f - 1`
subtracts. See 6.3.4.

### 4.3 `pattern` lexing

When the token immediately before a `STRING` is the word `pattern`, and that word is
not itself preceded by `.` or `:`, the lexer replaces that word and the string with
a single `PATTERN` token whose value is the string's contents, kept as typed except
that `\"` becomes `"`. (`x.pattern "..."` is therefore a property call, not a
pattern.) Flag words are parsed by the expression grammar (5.5), not the lexer:

```text
'pattern' STRING ( 'everywhere' | 'ignoring' 'case' | 'by' 'line' )*
```

The regular expression is validated at parse time and always uses the `u` flag, plus
`g` for `everywhere`, `i` for `ignoring case`, and `m` for `by line`.

### 4.4 Markup lexing

`<` starts a `MARKUP` token only when it appears in **operand position**: at the
start of an expression, after one of `return is are print fail with then else if
and or otherwise not in`, or after a symbol other than `)` `.` `:`; and when the
next character is `[A-Za-z_>]`. Otherwise `<` is the comparison operator.

Consequences: `x is <Card />` and `print <div />` are markup, `a < b` is a
comparison, and `render (<Card />)` / `render with <Card />` pass a tag as an
argument (`render <Card />` compares). A markup token owns all of its source,
including newlines; expressions inside `{...}` are tokenized and parsed as ordinary
Prose expressions (5.7).

## 5. Phrase grammar `G(Γ)`

The grammar below assumes layout has produced logical lines and that `Γ` is known.
Call rules that depend on `Γ` are summarized in 6.2.

### 5.1 Programs and statements

```text
program     ::= statement*

statement   ::= function-decl
              | type-decl
              | use-decl
              | if-stmt
              | while-stmt
              | for-stmt
              | for-each-stmt
              | try-stmt
              | simple-stmt

simple-stmt ::= print-stmt
              | return-stmt
              | loop-control
              | fail-stmt
              | destructure-stmt
              | assignment
              | comment
              | unset-decl
              | expression-stmt
```

Statement classification is ordered, not free choice. Given the tokens of one
logical line:

1. **Keyword forms** by first token: `function`, `type` (when the next word is not
   `is`), `use`, `if`, `while`, `for`, `try`, `print`, `return`, `skip`, `stop`,
   `fail`.
2. `export` prefix: only a top-level `function`, `type`, or assignment may follow.
3. **Destructuring** if the line is `NAME (',' NAME)* 'are' ...`.
4. **Assignment** if the line is `NAME accessor* 'is' ...` or
   `NAME 'as' type 'is' ...`.
5. **String-first line** if the first token is `STRING`: an expression statement
   whose value is the string, or a comma list of values. When the line is exactly
   one string it is a comment.
6. **Unset declaration** if the line is exactly one `NAME` that is not a function.
7. Otherwise an **expression statement**, which must evaluate to a call, method
   call, constructor call, or `wait for` (`simple()` enforces this in normal
   parsing; editor-only "loose" parsing is more permissive). String-first lines are
   the one exception to the call-shape restriction.

### 5.2 Declarations and modules

```text
function-decl ::= 'function' NAME type-params?
                  ( 'takes' param ( ',' param )* ( ',' )? )?
                  ( 'giving' type )?
                  block

param         ::= NAME ( 'as' type )?
type-params   ::= 'of' type-param ( ',' type-param )* ( ',' )?
type-param    ::= NAME ( 'as' type )?

type-decl     ::= 'type' TYPE-NAME type-params? 'is' type type-body?
type-body     ::= NEWLINE INDENT ( comment | type-field )+ DEDENT
type-field    ::= WORD 'as' type

use-decl      ::= 'use' ( 'type' )? NAME ( ',' NAME )* 'from' STRING

assignment    ::= ( 'export' )? NAME ( 'as' type )? 'is' list?    (* name target *)
                | 'export' NAME                                   (* unset export *)
                | NAME accessor+ 'is' list?                      (* property/index target *)

accessor      ::= ':' ( WORD | '(' expr ')' )
                | '.' ( WORD | '(' expr ')' | NUMBER )
```

- A trailing comma in a parameter list is only legal when `giving` follows; without
  `giving`, the last parameter has no trailing comma. A trailing comma in `of` is
  only legal before `takes`, `giving`, `is`, or `return`.
- `TYPE-NAME` is `[A-Z] [A-Za-z0-9_]*` (optionally namespaced). Type parameters are
  lowercase placeholders (5.8).
- `export` is legal only at top level, and only before `function`, `type`, or an
  assignment.
- `use` imports names; there are no aliases, default imports, namespace imports, or
  braced lists. A `type` after `use` imports TypeScript types only and emits no
  JavaScript. A `.prose` path additionally supplies call arities (6.2).
- An assignment target is a name optionally followed by `:` property steps and `.`
  steps. A declared type (`as`) may not be combined with a property target, and an
  exported assignment must target a plain name.
- An indexed target requires a value: `word.1 is` is an error; a named target may
  omit it (`missing is`, `missing`), which declares it unset. `export missing` is an
  unset export.
- `accessor` with `(` is a **computed** key: `record:("user_id")`,
  `settings:(name)`. `.` with `NUMBER` is a one-based position; `.` with a word is
  contextual (6.1.4).

### 5.3 Blocks and control flow

```text
if-stmt      ::= 'if' expr ( 'then' )? if-body
                 ( 'else' 'if' expr ( 'then' )? if-body )*
                 ( 'else' if-body )?

if-body      ::= inline-simple | block
inline-simple ::= simple-stmt                      (* same logical line *)

while-stmt   ::= 'while' expr block
for-stmt     ::= 'for' NAME 'is' expr 'to' expr block
for-each-stmt ::= 'for' 'each' NAME ( ',' NAME )* 'in' list block
try-stmt     ::= 'try' block 'on' 'error' ( NAME )? block
```

- `else` and `else if` start logical lines at the same indentation as their `if`.
  `else` with no `if` is an error.
- An inline condition's body is the rest of the logical line. `then` is optional,
  but required when the condition ends in a call and the body starts with a name
  (6.3.6).
- `for` evaluates its upper bound once, loops inclusively, and steps by one.
- `for each` iterates arrays, strings (by code point), and other JavaScript
  iterables; several names destructure pairs.
- `try` must be followed by `on error` at the same indentation. The optional name
  binds the thrown value.
- `skip` and `stop` are the loop controls (`continue` and `break`); they take no
  operand and must be inside a loop of the same function (6.4).

### 5.4 Simple statements

```text
print-stmt      ::= 'print' list
return-stmt     ::= 'return' list?
loop-control    ::= 'skip' | 'stop'
fail-stmt       ::= 'fail' expr
destructure-stmt ::= NAME ( ',' NAME )* 'are' list
unset-decl      ::= NAME
comment         ::= STRING
expression-stmt ::= expr                            (* call-shaped only *)
```

- `list` is comma-separated expressions; a `print` or `return` with commas produces
  one array value, not multiple arguments.
- `fail` takes exactly one expression.
- `are` destructures a collection's items in order; a comma list assigns several
  names at once.
- `return` is only legal inside a function or lambda. A bare `return` yields
  `undefined`.

### 5.5 Expressions

Precedence, from loosest to tightest:

| Level | Forms | Associativity |
| --- | --- | --- |
| 5 | trailing conditional `a if c else b` | non-associative |
| 10 | `or`, `otherwise` | left |
| 20 | `and` | left |
| 25 | prefix `not` | right |
| 30 | `= != < > <= >=`, `is [not] a/an ...` type test | left |
| 40 | `+ -` | left |
| 50 | `* / % mod xor shifted left/right by` | left |
| 60 | prefix `-`; argument boundary | right |
| 70 | accessors, calls, `with`, `run` | left |

```text
expr        ::= conditional
conditional ::= or-expr ( 'if' or-expr 'else' or-expr )?
or-expr     ::= and-expr ( ( 'or' | 'otherwise' ) and-expr )*
and-expr    ::= not-expr ( 'and' not-expr )*
not-expr    ::= 'not' not-expr | comparison

comparison  ::= additive ( ( '=' | '!=' | '<' | '>' | '<=' | '>=' ) additive
                          | type-test )*

type-test   ::= 'is' ( 'not' )? ( 'a' | 'an' )
                ( 'text' | 'number' | 'boolean' | 'function' | 'list' | 'object'
                | TYPE-NAME ( ( ':' | '.' ) WORD )* )

additive    ::= multiplicative ( ( '+' | '-' ) multiplicative )*
multiplicative ::= unary ( ( '*' | '/' | '%' | 'mod' | 'xor' | shift ) unary )*
shift       ::= 'shifted' ( 'left' | 'right' ) 'by'

unary       ::= 'not' not-expr | '-' unary | postfix
postfix     ::= primary ( accessor | call | 'run' )*
call        ::= 'with' arguments | arguments
arguments   ::= argument ( ',' argument )*
argument    ::= unary
list        ::= expr ( ',' expr )*
```

`call` is subject to the arity rules in 6.2; `list` is the comma form used by
`print`, `return`, assignments, `are`, `for each`, and parentheses.

Details that are easy to get wrong:

- **`not` binds looser than comparisons, tighter than `and`**: `not a = b` is
  `not (a = b)`.
- **Unary minus binds tighter than `*`**: `-2 * 3` is `(-2) * 3`. A binary `-`
  needs the operand of a prefix `-` to stop before it.
- **`otherwise` shares `or`'s precedence** but nullish semantics; `value otherwise
  fallback` keeps `0`, `""`, and `false`.
- **`mod` is mathematical modulo**, unlike `%` and prefix `remainder`, but it shares
  their precedence.
- **`shifted left by` compiles to `<<`; `shifted right by` compiles to `>>>`**
  (unsigned); both bind like multiplication.
- **The trailing conditional is looser than everything else and does not nest**:
  `a or b if c else d` is `(a or b) if c else d`. Its `else` is required, and both
  its condition and its branches stop at the next `if`, so a nested trailing
  conditional needs parentheses: `a if b else (c if d else e)`.
- **The prefix conditional is a primary**: `if c then a else b`. It requires both
  `then` and `else`, and its `else` branch extends as far right as possible.
- **A comma is not an expression operator.** Commas are consumed by `list`,
  `arguments`, object entries, and destructuring.

```text
primary     ::= NUMBER | STRING | PATTERN
              | 'true' | 'false' | 'null' | 'unset'
              | NAME
              | '(' list ( ',' )? ')'
              | 'array'
              | 'object' ( object-entries )?
              | 'function' type-params? ( 'takes' param ( ',' param )* ( ',' )? )?
                           ( 'giving' type )?
                           ( 'return' expr | block )
              | 'if' expr 'then' expr 'else' expr
              | 'maybe' postfix
              | 'wait' 'for' unary
              | 'remainder' unary unary
              | 'each' 'of' unary
              | 'new' NAME accessor* ( 'with' arguments | arguments )?
              | markup
```

- `(x)` groups; `(x,)` is a one-item array; `(x, y)` is an array. Parentheses are
  never empty (use `array`). A grouped value is a value, not a callable by
  adjacency: `(f) 1` is an error; write `(f 1)` or `f 1`.
- `array` is the empty array literal.
- `maybe` protects the immediately following access/call chain; parentheses stop the
  chain from extending further.
- `wait for` awaits; its operand is parsed at level 60, so arithmetic after it
  applies to the awaited result.
- `remainder a b` is prefix `%`; its two operands are parsed at level 60, so
  compound operands need parentheses.
- `each of` spreads into a list, `print`, or a call of unknown arity; it may not
  spread into a fixed-arity Prose call.
- A `function` with an indented body may appear anywhere on a line, but only one
  per line, and not in `if`, `while`, `for`, or inline-conditional headers.

### 5.6 Objects and arrays

```text
object-entries ::= object-entry ( ',' object-entry )*
object-entry   ::= 'like' unary
                 | WORD 'is' expr
                 | NAME
```

- `object` with no entries is empty. Inline entries are separated by commas and the
  object consumes every following comma at its level, like a call; parenthesize it
  when more arguments or list items follow.
- `like other` copies all of another object's properties shallowly; later entries
  override earlier ones.
- A bare `NAME` entry is shorthand for `NAME is NAME`.
- An indented object body accepts only `name is value`, `like other`, and comments;
  values may be nested indented objects or functions. `name is` creates an unset
  property.
- `[ ... ]` is not array syntax; arrays are comma lists (`1, 2, 3`), `array` for the
  empty array, and parenthesized lists (5.5).

### 5.7 Markup

```text
markup      ::= element
element     ::= '<' tag? attribute* ( '/>' | '>' content* '</' tag? '>' )
tag         ::= html-tag | component
html-tag    ::= [a-z] [A-Za-z0-9_-]*
component   ::= [A-Z_] [A-Za-z0-9_]* ( '.' [A-Za-z_] [A-Za-z0-9_]* )*
attribute   ::= WORD ( '=' ( STRING | '{' expr '}' ) )?
              | '{' 'like' expr '}'
content     ::= element | '{' expr '}' | TEXT
```

- Lowercase tags become element name strings; uppercase (dotted) tags become
  component values resolved by the ordinary name rules.
- `<> ... </>` is a fragment and takes no attributes.
- Attributes need a space between them; attribute names may not contain periods;
  duplicate attributes are errors.
- Attribute names use the usual snake_case → camelCase conversion
  (`class_name` → `className`); `aria-label` and `data-id` keep their spelling.
- A boolean attribute (`disabled`) means `disabled={true}`.
- Attribute string values may use single or double quotes; entities are decoded.
- Braces contain ordinary Prose expressions, including commas (arrays) and inline
  lambdas, but not indented lambda bodies.
- Text follows JSX whitespace rules: indentation and blank lines vanish; nonempty
  text lines join with spaces; same-line spaces are kept. Entities are decoded;
  a literal `}` must be written `&#125;`.
- Attribute evaluation is left to right; later spreads and attributes override
  earlier ones. A closing tag must match its opening tag exactly.
- The compiler imports `createElement`/`Fragment` from `react` when markup is
  present; React must be installed in the consuming project.

### 5.8 Types

```text
type        ::= single-type ( 'or' single-type )*
single-type ::= STRING | NUMBER
              | '(' type ( ',' type )* ')'
              | 'maybe' single-type
              | 'list' 'of' single-type
              | 'set' 'of' single-type
              | 'map' 'from' single-type 'to' single-type
              | 'function' ( 'taking' single-type ( 'and' single-type )* )?
                          ( 'giving' single-type )?
              | 'object'
              | builtin-type
              | TYPE-NAME ( ( ':' | '.' ) WORD )*
                          ( 'of' single-type | 'from' single-type 'to' single-type )?
              | type-variable

TYPE-NAME ::= [A-Z] [A-Za-z0-9_]*
builtin-type ::= 'text' | 'number' | 'boolean' | 'any' | 'unknown'
               | 'nothing' | 'unset' | 'null' | 'true' | 'false'
type-variable ::= NAME        (* lowercase, not a builtin or type keyword *)
```

- `or` is lowest; `maybe`, `list of`, `set of`, `map from ... to ...`, and
  `function taking ... giving ...` each bind one `single-type`. Hence
  `list of A or B` is `(list of A) or B`; write `list of (A or B)`.
- `(A)` groups; `(A, B)` is a tuple.
- `A or B` is a union; `maybe T` is `T | undefined`.
- Named types are capitalized; namespaces use `:` (`Intl:DateTimeFormatOptions`)
  or `.`, and render as `.` in TypeScript.
- Lowercase names are type variables (implicit generics) unless declared with
  `of name as Bound`.
- `function taking` parameters that are trailing `maybe` become optional.
- Annotations never affect runtime behavior; they feed `.d.prose.ts` declarations
  and the checker.

## 6. Static semantics

### 6.1 Names and scopes

1. There are only two kinds of scope: the **program/script** scope and a scope per
   **function or lambda**. `if`, `while`, `for`, `for each`, and `try` do not create
   scopes; variables assigned in them belong to the enclosing function or script.
2. A name resolves to the innermost binding, then enclosing scopes, then imported
   names, then the built-in JavaScript globals (`Math`, `JSON`, `Set`, `fetch`,
   `document`, ...), and otherwise is an error:
   `Unknown name 'x'. Assign it before using it, or check the spelling.`
3. Function names form a separate namespace from variables in the same scope:
   a variable, parameter, or loop variable may not use a function's name, and a
   function name cannot be assigned. Function declarations are visible throughout
   the whole program, including before their declaration and recursively.
4. Assigning a name inside a function creates or updates a **local**; a local
   shadows an outer binding of the same name for the whole function. Top-level
   assignment creates a **script** binding. Imported names cannot be reassigned at
   the top level.
5. Assignment to a property or position mutates the value; it does not declare a
   name. Arrays and objects are shared by reference.
6. Reading a missing property of an object gives unset; reading a property of
   `null`/unset is a runtime error (use `maybe`). The checker knows the difference.

### 6.2 Call arity `Γ`

`Γ` maps each callable **binding** (not just its spelling) to an arity: `0`, `n ≥
1`, or `⊥` (unknown). The sources of arity are:

- named functions: parameter count from `takes`;
- lambdas: parameter count;
- builtins `length`, `char_to_number`, `number_to_char`: `1`;
- variables assigned only functions of one parameter count (including aliases and
  branches/loops): that count; differing counts or an untyped source: `⊥`;
- Prose imports: the exporting module's declaration, read from source without
  executing it; forwarding modules are followed (depth ≤ 128); unresolved cycles:
  `⊥`;
- methods of object literals (`calculator.add`), including aliases, `like` copies,
  nested objects, and declared object result types: the property's function arity;
- fixed JavaScript collection methods on values known to be a collection:
  `Map` (`get` 1, `set` 2, `has` 1, `delete` 1, `clear` 0, `keys`/`values`/`entries`
  0), `Set` (`add` 1, `has` 1, `delete` 1, `clear` 0, `keys`/`values`/`entries` 0),
  `WeakMap` (`get` 1, `set` 2, `has` 1, `delete` 1), `WeakSet` (`add` 1, `has` 1,
  `delete` 1);
- everything else (JavaScript globals, methods of unknown receivers, values from
  untyped parameters): `⊥`.

Because a variable's arity can depend on another variable's arity, the compiler
computes `Γ` as a **fixed point**: parse with the current `Γ`, infer arities, reparse,
and repeat until the inferred environment's fingerprint stops changing (at most 64
rounds). If it does not converge, compilation fails with
`Call boundaries could not be inferred consistently. Use with to make the argument
lists explicit.`

Given `callee` with arity `a`:

| `a` | call by adjacency (`f x`) | `f with ...` | `f run` |
| --- | --- | --- | --- |
| `n ≥ 1` | exactly `n` comma-separated arguments | 1..n arguments; omitted trailing arguments are unset (builtins require all) | error |
| `0` | error (`Expected 'run'`) | error (no value to read) | allowed |
| `⊥` | exactly one argument | one or more arguments | allowed |

- Each argument is parsed at level 60, so it may be a call, literal, grouped
  expression, lambda, prefix conditional, or unary expression, but not a top-level
  binary expression or trailing conditional.
- A call consumes its declared arguments **before** the surrounding expression
  continues: `fibonacci n - 1` is `fibonacci(n) - 1`; `f 1, 2 + 3` is ambiguous and
  rejected (6.3.2).
- A call with no arguments must use `run`; a bare name is a value (and a bare
  single-name statement is an unset declaration).
- `new` uses the call rules for arguments, but omitting arguments is always allowed
  (`new Foo` constructs with none); a known constructor consumes its arity after
  `new`, an unknown one takes one argument or `with`, and `run` is not used.
- `with` consumes every comma-separated value that follows it at that nesting
  level; commas inside the call's own parentheses belong to it.
- A fixed-arity Prose function rejects spread arguments (`each of`), because its
  parameter count is fixed.

### 6.3 Ambiguity rules and their diagnostics

These are the places where a reader could parse two ways; the compiler refuses to
guess.

1. **Unknown-arity comma.** In a call of unknown arity, `f x, y` could be two
   arguments or an array element after a one-argument call. It is a
   `PROSE_CALL_BOUNDARY` syntax error; write `f with x, y` or `(f x), y`.
2. **Arithmetic after arguments.** After an explicit argument list (a known call
   with more than one parameter, or any `with` list), a following `+ - * / % mod
   xor shifted` is ambiguous: `f a, b + 1`. Parenthesize the last argument or the
   whole call.
3. **A multi-argument call inside another call's arguments** needs parentheses:
   `outer with (inner with 1, 2)`, not `outer with inner with 1, 2`.
4. **Negative-argument spacing.** With a property, method, or unknown-arity callee,
   `f - 1` subtracts, `f-1` subtracts, and `f -1` is rejected: the space before `-`
   but not after it suggests a negative argument, so write `f (-1)` or
   `f with -1`. With a known-arity function name that takes at least one parameter,
   all three spell `f(-1)`; subtract from its result with `(f 1) - 1`.
5. **`if` condition ending in a call.** `if ready count is 5` reads `ready count` as
   a call and then cannot tell whether `is 5` is the body. Write
   `if ready then count is 5` or give the `if` an indented body.
6. **Nested trailing conditionals** need parentheses:
   `a if b else (c if d else e)`.
7. **Inline object followed by commas.** An inline object consumes following
   commas; parenthesize it to pass more arguments or list items.
8. **Markup versus comparison.** `<` is markup only in operand position; to pass a
   tag as an argument use `render (<Card />)` or `render with <Card />`.

### 6.4 Placement restrictions

- `function`, `type`, and `use` declarations are top-level only.
- `export` is top-level only and applies only to functions, types, and assignments.
- `return` is legal only inside a function or lambda (not at top level).
- `skip` and `stop` are legal only inside a loop in the same function; they cannot
  cross a function or lambda boundary.
- A `function` with an indented body may appear on any statement line, but only one
  per line, and not in an `if`, `while`, or `for` header or an inline conditional.
- An expression statement must be a call, method call, constructor call, or `wait
  for`; `1 + 2` alone is not a statement.
- A top-level `wait for` requires module output: a value `use` or `export`, markup,
  or a runtime import. Otherwise it is an error, since a JavaScript script cannot
  contain a top-level `await`.
- `else` requires a preceding `if` at the same indentation; `try` requires `on
  error` at the same indentation.
- Type names begin uppercase; type parameters and implicit type variables begin
  lowercase. Explicit `of` lists must not duplicate or use builtin names.
- `length`, `char_to_number`, and `number_to_char` are reserved standard-library
  names and cannot be declared as variables, parameters, or functions.
- Exported names may not also be imported or reassigned at top level.

## 7. Why a plain context-free grammar cannot express Prose

Prose is not context-free in three independent ways:

1. **Layout.** Statement boundaries are indentation, and continuation depends on the
   tokens at the end of the previous line (including an open parenthesis and the
   last word). This is the usual offside-rule context sensitivity.
2. **Call boundaries depend on `Γ`.** `f a, b` is a two-argument call, a one-argument
   call followed by an array element, or an error, depending on `f`'s inferred arity
   — which may come from another module, an object literal, or a fixed point over
   this program. No finite set of productions can encode all arities; the grammar is
   an infinite family `G(Γ)`.
3. **Contextual dot and markup.** `.name` is a position on strings/lists and a
   property elsewhere, depending on scope and types; `<` is markup or comparison
   depending on operand position. These are resolved with local context and semantic
   predicates.

Practical formulations:

- **Parameterized grammar.** Use the EBNF above with `Γ` as an inherited attribute;
  a parser generator that supports semantic predicates or a hand-written recursive
  descent parser passes `Γ` down. This is what the implementation does.
- **Scannerless PEG / GLL with predicates.** Encode the arity rules as predicates on
  the call production. The fixed-point driver around the parser computes `Γ`; it is
  not part of the grammar.
- **Attribute grammar.** Treat indentation, `Γ`, and name resolution as inherited
  attributes; the "parse" relation is then well-defined, but not as a CFG.

In other words: a formal grammar exists, but it is a **layout-sensitive,
arity-parameterized** grammar plus a static-semantics fixed point, not a single
`LALR(1)` or `EBNF` file.

## 8. Implementation map

| Concern | Where |
| --- | --- |
| Tokens, strings, numbers, `pattern`, markup token | `tokenize` in `src/lexer.js` |
| Physical → logical lines, markup trees | `lexSource` in `src/lexer.js` |
| Indentation and continuations | `sourceLines` and `continues` in `src/layout.js` |
| Statement grammar | `Parser.block` / `Parser.simple` in `src/parser.js` |
| Function headers and `use` | `functionHeader`, `useStatement` in `src/parser.js` |
| Expression grammar and precedence | `Expression.parseValue`, `precedence` in `src/expression.js` |
| Calls, `with`, `run`, arity checks | `Expression.call`/`arguments`/`callsByAdjacency` in `src/expression.js` |
| Types | `Expression.typeExpression`/`singleType` in `src/expression.js` |
| Markup | `src/markup.js`, `Expression.markup` in `src/expression.js` |
| Arity inference | `discoverCallArities` in `src/parser.js`, `src/call-arity.js` |
| Name resolution | `resolve`/`createScope` in `src/transpile.js` |
| Checking output | `compile(..., { check: true })` in `src/transpile.js` |

## 9. Not in the grammar (unsupported)

Documented in the README and confirmed by the parser:

- nested named functions and default imports;
- `break`/`continue` (use `skip`/`stop`), `switch`, `class`, `try`/`catch`;
- `async`/`await` keywords (use `wait for`), `await` as a prefix;
- numeric exponents, hex/binary literals, numeric separators, leading-dot numbers;
- multiline, raw, or interpolated strings; block comments; single-quoted strings
  outside markup attributes;
- Unicode identifiers; braced import lists or import aliases;
- assignment as an expression;
- user-defined operators or precedence overrides;
- arrays written with `[...]` (use comma lists).

## 10. Verification note

The grammar above was cross-checked by reading the parser and by compiling probe
programs (`print 1 + 2 * 3`, `print not 2 + 3 = 5`, `x is 1, 2`, and
`print f 3 + 1`) with `node bin/prose.js --run`. The repository's suite currently
reports **607 tests, all passing**.
