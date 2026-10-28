# Prose: a concept programming language

```text
print "Hello world!"
```

## Goals

1. Read as close as possible to natural English.
2. Use as few non-letter characters as possible.
3. Transpile to JavaScript so I can use it.

## Try the first transpiler

Requires Node.js 20.6 or newer. The compiler has no runtime dependencies or installation step. On Windows PowerShell, use `npm.cmd`
to avoid the script execution policy restriction on `npm.ps1`.

```sh
npm.cmd install
npm.cmd test
npm.cmd run example
npm.cmd run example:fibonacci
npm.cmd run example:factorial
npm.cmd run example:cipher
npm.cmd run example:objects
npm.cmd run example:arrays
npm.cmd run example:habits
npm.cmd run example:tour
node bin/prose.js examples/fizzbuzz.prose --run
node bin/prose.js examples/fizzbuzz.prose > fizzbuzz.js
node fizzbuzz.js
```

The CLI writes JavaScript to standard output by default. Add `--run` to
execute it with Node.js; any `.prose` files it imports are compiled as they
load. Run programs you trust; execution has ordinary Node.js permissions.

`examples/tour.prose` uses every feature below in one program, and
`examples/habits.prose` shows the newest ones across two files.

## Syntax highlighting in VS Code

The language extension in `editors/vscode` registers `.prose` files as **Prose**
and colors keywords, function declarations, parameters, loop variables,
standard-library calls, strings, numbers, operators, and indexing with a
Prose-only palette for dark backgrounds. Standalone quoted comments receive
comment coloring.

Install `dist/prose-language-0.1.3.vsix` with **Extensions: Install from VSIX...**
or run:

```powershell
code.cmd --install-extension dist/prose-language-0.1.3.vsix --force
```

Reload your VS Code window if an already-open file retains its old coloring.
User-defined function calls currently use identifier coloring; function
declarations and built-in calls have distinct scopes.

`npm.cmd install` installs the development dependencies needed for the grammar
tests; running the compiler and examples directly still requires only Node.js.
See [the extension README](editors/vscode/README.md) for development and packaging.

## Implemented subset

- Assignment: `answer is 42`.
- Printing one expression: `print answer`.
- Numbers, double-quoted strings with JSON escapes, `true`, `false`, and `null`.
- Arithmetic: `+`, `-`, `*`, `/`, `%`, mathematical `mod`, and unary minus.
- Comparisons: `=`, `!=`, `<`, `>`, `<=`, `>=`. Equality is strict.
- Logical `not`, `and`, and `or`, with short-circuit evaluation.
- Parentheses for grouping.
- Prefix `remainder number divisor`; use parentheses for compound arguments.
- Indented `if`, `else if`, and `else` bodies.
- Ascending, inclusive loops: `for number is 1 to 100`.
- Indented `while` loops, with the condition checked before each iteration.
- Top-level functions, comma-separated parameters, and recursive calls.
- `return expression` or bare `return` inside a function.
- Inline conditionals such as `if number < 2 return 1`.
- One-based Unicode string indexing and single-character indexed assignment.
- Standard-library `length`, `char_to_number`, and `number_to_char`.
- Standalone string expressions as comments, and unset variable declarations.
- Indented object literals with property-only bodies, and `:` property access and assignment.
- Comma-separated arrays with one-based indexing, shared by reference like objects.
- `for each item in items`, including several variables for pairs: `for each name, count in counts`.
- Inline `if ... then ... else ...` values, the `unset` value, and the `otherwise` fallback operator.
- Functions as values, with inline (`function takes x return x * 2`) or indented bodies.
- JavaScript globals, methods called with `with` or `run`, and `new`.
- `maybe`, which reads through values that might be unset or `null`.
- Modules: `use name from "path"` and `export`, plus a Vite plugin. Functions
  imported from other `.prose` files keep their argument counts.
- Compile-time errors for names that are never assigned, imported, or provided
  by JavaScript, and for `with` calls whose arguments could be read two ways.

```text
total is 0
for number is 1 to 5
    total is total + number
if total = 15
    print "It works!"
else
    print total
```

Multiplication, division, remainder, and `mod` bind tighter than addition and
subtraction, followed by comparisons, `not`, `and`, then `or`.
Operators at the same precedence associate left to right. Strings and numbers
use JavaScript arithmetic behavior; division can produce fractions.

Use consistent indentation. A tab counts as four spaces; blank lines are
ignored. Each body must be indented beyond its header. Variables are script scoped at the top level and local inside functions.
Assignment inside a conditional or loop updates the containing scope's variable.
Each function invocation gets its own locals; assigning a name inside a function
creates a local even if a global has the same name. Parameters can be reassigned.
For-loop upper bounds are evaluated once on entry, and the iterator advances by one.
A while-loop condition is reevaluated before every iteration, so an initially
false condition skips the body entirely. Assignments in its body persist in the
containing scope, and `return` exits the containing function.

```text
number is 3
while number > 0
    print number
    number is number - 1
```

This prints `3`, `2`, then `1`.

## Functions and call order

```text
function fibonacci takes number
    if number < 2 return 1
    previous is fibonacci (number - 1)
    previous_again is fibonacci (number - 2)
    return previous + previous_again

print fibonacci 10
```

This prints `89`, preserving the example's base cases of 1 for both 0 and 1.
Run `npm.cmd run example:fibonacci` to print the first eleven values.

**Without parentheses, apply the function first, then continue the surrounding
expression.** For example, `fibonacci number - 1` means
`fibonacci(number) - 1`. Write `fibonacci (number - 1)` to subtract before the call.
Parentheses can also group the result: `(fibonacci number) - 1`.
Indexing binds before calls: `char_to_number word.i` means
`char_to_number (word.i)`. Normal arithmetic precedence still applies outside calls.

Functions declare their arguments with `takes`; calls separate arguments with
commas. Compound arguments need parentheses:

```text
function multiply takes left, right
    return left * right

print multiply 2, 3 + 4
print multiply 2, (3 + 4)
```

These print `10` and `14`, respectively. A call consumes the declared number of
arguments. Nested calls follow the same rule; parentheses make grouping explicit.
Missing arguments produce a syntax error. A comma after a complete call starts
another array element, as described below.

Declare a zero-argument function with `function greet` and call it with
`greet run`. Calls can appear as standalone statements or inside expressions.

A call can also list its arguments after `with`. This form may leave trailing
arguments out; they arrive unset, which allows optional parameters:

```text
function pluralize takes count, singular, plural
    if plural = unset plural is singular + "s"
    return count + " " + (if count = 1 then singular else plural)

print pluralize with 2, "tag"
print pluralize with 3, "entry", "entries"
```

These print `2 tags` and `3 entries`. Passing more arguments than the
function takes is a syntax error.
Functions are declared at the top level and can call functions declared later,
including themselves. Function names cannot also be used as variables or
parameters. Reaching the end of a function or using bare `return` yields
JavaScript `undefined`.

## Strings, indexing, and the standard library

String positions start at **1**. A dot accesses the position given by a number
or variable; parentheses group a calculated index:

```text
word is "a😀z"
i is 2
print word.i
print word.(i + 1)
word.2 is "b"
word.4 is "!"
print word
```

This prints `😀`, `z`, and `abz!`. Positions and `length` count Unicode code
points, so 😀 takes one position. Combining marks remain separate code points.

- Missing reads return unset (`undefined` in emitted JavaScript).
- A write replaces an existing position or appends at `length + 1`.
- Writes cannot skip positions or use a non-positive or fractional index.
- This milestone supports assigning exactly one code point per indexed write.
  Multi-character replacements are not supported yet.
- Strings are values: indexed assignment creates the updated string for that
  variable; copies and the caller's string are unchanged.

A bare variable name or an assignment without a value initializes an unset
variable. The first indexed write at position 1 makes it a string:

```text
result
alternative is
result.1 is "a"
alternative.1 is "b"
empty_string is ""
```

Standalone string expressions have their values discarded, allowing comments
such as `"This is a comment"`.

The first standard-library functions take one argument, using the same call
and grouping rules as user functions:

| Function | Behavior |
| --- | --- |
| `length value` | Number of Unicode code points in a string, or elements in an array |
| `char_to_number character` | Unicode code point of a single character |
| `number_to_char number` | Character for an integer code point from 0 to 1114111 |

These names cannot also be declared as variables, parameters, or user functions.
Invalid inputs report an error with the original source line.

`mod` is mathematical modulo: `-1 mod 26` gives `25`. Its result has the
divisor's sign (or is zero); the divisor must be nonzero and both operands must
be finite numbers. Existing `%` and `remainder` keep JavaScript remainder
behavior: `-1 % 26` gives `-1`.

## Arrays

Comma-separated values make an array:

```text
names is "Ada", "Grace", "Linus"
print names.1
names.4 is "Margaret"
```

Positions start at 1. `length names` returns the element count. Missing reads
return unset. A write replaces an element or appends at `length + 1`; skipped,
non-positive, and fractional indexes are rejected. Elements may contain any
supported value, including objects and nested arrays.

Parentheses without a comma retain their ordinary expression meaning. A
trailing comma inside parentheses makes a one-item array, and `array` creates
an empty array:

```text
scalar is ("Ada")
single is ("Ada",)
empty is array
nested is (1, 2), (3, 4)
print (nested.1).2
```

For nested numeric indexes, use parentheses as above or `nested.(1).2`.
`nested.1.2` contains the decimal number `1.2`, so it is not a chain of
two integer indexes. Variable indexes can chain directly: `nested.i.j`.

### Calls and commas

Each call consumes exactly its declared argument count. Commas separate those
arguments; any commas left after a complete expression form an array:

```text
function combine takes first, second
    return first + second

result is combine "Ada", "Grace"

function double takes number
    return number * 2

results is double 2, double 3
```

`result` is `"AdaGrace"`; `results` is the array `4, 6`. Parentheses around
each call are optional. To pass one array argument, put the entire array in
parentheses:

```text
function first takes values
    return values.1

print first ("Ada", "Grace")
```

Lists also work in return values, object fields, and indexed assignments.
A trailing comma is supported only inside parentheses. Printing a list
prints one array value; it is not a multiple-argument print statement.

### Sharing and copies

Arrays are shared, like objects: assigning an array, storing it in another
array or object, or passing it to a function refers to the same array, so a
change through one name is visible through all of them. This matches
JavaScript, so libraries and frameworks that compare arrays by identity
(such as React) see the same array. Use the JavaScript `slice` method to make
a separate copy:

```text
original is 1, 2
same is original
copy is original:slice run
same.1 is 99
print original.1
print copy.1
```

This prints `99` and `1`. `slice` copies one level: arrays and objects inside
the copy are still shared.

Unset variables still become strings when first written through an index.
Start with `items is array` to append arbitrary array elements.

Run `npm.cmd run example:arrays` to try array iteration and sharing.

## Loops over collections

`for each` visits the elements of an array, the characters of a string (by
code point), or the values of any other JavaScript collection. A comma list
works directly, and several variables take apart pairs, such as the entries
of a `Map`:

```text
for each value in 2, 3, 5
    print value

for each name, score in scores
    print name + ": " + score
```

As with `for`, the loop variables belong to the surrounding function or
script and keep their last values after the loop.

## Inline if, unset, and otherwise

`if condition then value else other` chooses a value inside an expression.
Its `else` part extends as far right as it can, so wrap the whole inline `if`
in parentheses when more of the expression follows:

```text
label is count + " " + (if count = 1 then "entry" else "entries")
```

`unset` is the missing value (JavaScript `undefined`). `value otherwise
fallback` gives `fallback` when `value` is unset or `null`, and `value`
otherwise; unlike `or`, it keeps `0`, `""`, and `false`.

## maybe

Reading a property of unset or `null` is an error, which points at the line
where something unexpectedly went missing. When a value may legitimately be
missing, put `maybe` before the chain that reads it: if any `:` property,
`.` position, or call in the chain meets unset or `null`, the whole chain is
unset instead.

```text
city is maybe person:address:city otherwise "unknown"
maybe input:focus run
maybe on_close run
```

`maybe` covers the chain directly after it, so `maybe a:b + c:d` checks only
`a:b`. A call's arguments are evaluated only if there is something to call.
Calling a value that exists but is not a function is still an error.

## Functions as values

`function` without a name makes a function value. With `return` on the same
line, everything after `return` (up to a comma that ends an argument) is the
result. Without `return`, the function's body is the indented lines that follow:

```text
doubled is values:map with function takes value return value * 2

labels is books:map with function takes book
    if book:pages > 500 return book:title + " (long)"
    return book:title
```

A function with an indented body can appear anywhere on a line, including
before other arguments (`later with function, 5`), but only one per line, and
not in `if`, `while`, or `for` lines or inline conditionals. Call a function
value with `with` and its arguments, or `run` when it takes none.

Function values can read the variables around them. Like named functions,
assigning a name inside one creates a local: it does not change an outer
variable with the same name. Changing an outer array or object (for example,
`seen:push with value`) does affect it.

## Using JavaScript

When no Prose variable has the name, common JavaScript globals are available:
`Math`, `JSON`, `Object`, `Array`, `Map`, `Set`, `Date`, `Number`, `String`,
`Promise`, `console`, `document`, `window`, `localStorage`, `fetch`, and more.

Call methods with `with` and comma-separated arguments, or `run` for none.
Create objects with `new`:

```text
print name:toUpperCase run
print words:join with ", "
seen is new Set with ("a", "b", "a")
print Math:max with 3, 9, 4
```

A `with` call takes every comma-separated value that follows it. Two places
where that could be read two ways are syntax errors, so a program never
silently means the other reading:

- Arithmetic right after the arguments. `counts:set with key, count + 1`
  could add one to the count or to the call's result. Write
  `counts:set with key, (count + 1)` or `(counts:get with key) + 1`.
- A call with several `with` arguments inside another call's arguments.
  `addDays with dateFromKey with key, 1` could pass the `1` to either call.
  Write `addDays with (dateFromKey with key), 1`.

Comparisons, `and`, `or`, and `otherwise` after a call apply to its result:
`counts:get with key otherwise 0` and `localDateKey with day = key` need no
parentheses. To call a method of a call's result, wrap the call in
parentheses: `(words:slice with 1):join run`. Calls without `with` keep the
call-first rule, so `length rows + 1` means `(length rows) + 1`.

JavaScript methods keep their JavaScript behavior, including zero-based
positions: `words:slice with 0, 2` takes the first two items, while `words.1`
reads the first item. `:` reads properties of any value except `null` and
unset, including strings (`name:length` is JavaScript's UTF-16 length; the
standard-library `length` counts code points). Property assignment requires
an object and runs JavaScript setters, so `document:title is "Hello"` changes
the page title.

## Names

Every name must be assigned in the current function (or the script), assigned
in an enclosing one, imported, or a JavaScript global. Anything else, such as
a misspelling, is a syntax error at compile time with its line number. A Prose
variable takes precedence over a JavaScript global with the same name
throughout its function or script.

## Modules and Vite

`use` imports names from a JavaScript or TypeScript module, and `export`
before a top-level `function` or assignment exports it:

```text
use addDays, dateFromKey from "../dates"

export function nextDay takes key
    return addDays with (dateFromKey with key), 1

export week_length is 7
```

When the path names a `.prose` file, the compiler reads that file's `export`
lines, so its functions are called just like this file's own, with the same
argument counts:

```text
use pluralize from "./text.prose"

print pluralize 2, "tag", "tags"
print pluralize with 3, "entry"
```

Names imported from JavaScript or TypeScript are values: call them with
`with` or `run`. No imported name can be reassigned at the top level. A file
with `use` or `export` compiles to an ES module. Exported names keep their
spelling, so JavaScript sees `nextDay` and `week_length`.

To use `.prose` files in a [Vite](https://vite.dev) project (including Vitest),
add this repository as a development dependency and its plugin to the Vite
configuration:

```ts
import prose from 'prose-lang/vite'

export default defineConfig({
  plugins: [prose()],
})
```

Import Prose modules with their extension: `import { nextDay } from './dates.prose'`.
The plugin compiles each file and shares one copy of the runtime helpers among
them. When a Prose file's exported functions change, the files that import it
are recompiled. For TypeScript, write a declaration file beside each Prose file, such as
`dates.d.prose.ts`, and enable `allowArbitraryExtensions` in `tsconfig.json`.

`compile(source, options)` returns `{ code, module }`; `transpile(source, options)`
returns only the code. Options:

- `runtime`: a module path to import the runtime helpers from instead of
  embedding them.
- `readModule(path)`: returns the source of an imported `.prose` file, for
  reading its exported functions. Compiling a file that imports one without
  this option is an error. The CLI and the Vite plugin provide it.

To run `.prose` files in your own Node.js program, register the module hook in
`src/node-hooks.js` with `module.register`; the CLI's `--run` does this.

## Objects

```text
person is object
    name is "Ada"
    age is 36
    address is object
        city is "London"

print person:name
print person:address:city
person:address:city is "Paris"
```

An `object` without an indented body creates an empty object. Indented bodies
contain only `name is value` property definitions, nested objects, and standalone
quoted comments. Ordinary statements such as `if`, `for`, and `print` are rejected.
Values can use expressions and function calls from the surrounding scope.
Property names do not create local variables, and a definition without a value
(`optional is`) creates an unset property.

A colon uses the literal property name: `person:name` reads the property named
`name`, regardless of a variable with that name. Keywords and standard-library
names are allowed as property names. Chained access is left to right, and both
`:` and `.` bind before function calls and arithmetic:

```text
print length person:name
print person:name.1
person:name.1 is "a"
```

A missing property reads as unset. Reading named properties of `null` or
unset, or writing named properties on anything that is not an object, reports
a line-numbered error. Object properties can be added or replaced after
construction; an unset value is not automatically turned into an object.

Objects use JavaScript reference semantics: assigning an object to another
variable shares it, and property changes through an alias or function parameter
affect the same object. Property assignment mutates the object and does not
declare a new variable in the function. String-valued properties retain the
existing Unicode indexing and append rules.

Object literals can be assigned to a variable or property, or returned from
a function with `return object` followed by indented property definitions.
A property's value can be a function value. Computed property names and
inline object bodies within function arguments are not implemented yet.

Run `npm.cmd run example:objects` to try the example.

## Caesar cipher

Run `npm.cmd run example:cipher` to encode `hello` as `khoor`, decode it again,
and demonstrate wrapping in both directions. The corrected cipher example
uses `mod 26` and an explicit empty string so empty input returns `""`.

The example targets lowercase `a–z`: it applies that same mapping to every
input character. Case-preserving or punctuation-preserving behavior would
require additional branches in the example.

## Design examples and next steps

FizzBuzz, Fibonacci, both factorial functions, and the Caesar cipher are executable. The Fibonacci recursive calls now use
parentheses to follow the call-order rule. `fibonacci_demo.prose` includes the
function and a loop that prints its values; `fibonacci.prose` defines the function
without calling it.

Run `npm.cmd run example:factorial` to print both implementations' answers for
each integer from 0 through 10 (two identical lines per input). The corrected
`factorial.prose` definitions are preserved; `factorial_demo.prose` adds the calls.

The corrected `caesar_cipher.prose` is preserved; `caesar_cipher_demo.prose` adds
calls that exercise it. `reading_list.prose` demonstrates `for each`, function
values, and JavaScript methods; `habits.prose` adds `maybe` and imports between
Prose files; `tour.prose` covers everything. MusicTicker remains a design sketch. Computed
object keys, multiple print arguments, nested named functions, default
imports, `try`/`catch`, and async are not implemented yet. Unsupported syntax
produces a line-numbered error.

The library entry points are `compile` and `transpile` in `src/transpile.js`.
The implementation parses expressions and indentation into an AST, resolves
every name, then emits a standalone JavaScript script or an ES module.
