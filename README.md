# Prose: a concept programming language

```text
print "Hello world!"
```

## Goals

1. Read as close as possible to natural English.
2. Use as few non-letter characters as possible.
3. Transpile to JavaScript so I can use it.

## Try it

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
`node bin/prose.js types <folder>` writes TypeScript declarations; see [Types](#types).
`node bin/prose.js check <folder>` checks Prose without running it or writing
files; see [Type checking](docs/type-checking.md).

`examples/tour.prose` uses every feature below in one program, and
`examples/habits.prose` shows one Prose file importing another.

## VS Code support

Type `.` or `:` after a value for type-aware field and method suggestions, or
use **Ctrl+Space** inside a partial name. See
[autocomplete](editors/vscode/README.md#autocomplete) for details and requirements.

The language extension in `editors/vscode` registers `.prose` files as **Prose**
and colors keywords, function declarations, parameters, loop variables,
standard-library calls, strings, numbers, operators, and indexing with a
Prose-only palette for dark backgrounds. Standalone quoted comments receive
comment coloring.

Saved Prose files are checked on open and save, with error squiggles and Problems
entries from the same checker as the CLI. Checking uses the project's TypeScript
and requires a trusted workspace. Set `prose.check.enabled` to `false` to disable
it. Dirty buffers wait until save; highlighting and formatting remain available
without TypeScript or Workspace Trust.

Build and install the extension as [its README](editors/vscode/README.md#install)
describes, then reload your VS Code window if an already-open file retains its
old coloring.
User-defined function calls currently use identifier coloring; function
declarations and built-in calls have distinct scopes.

`npm.cmd install` installs the development dependencies needed for the grammar
tests; running the compiler and examples directly still requires only Node.js.
See [the extension README](editors/vscode/README.md) for development and packaging.

Hover over variables, properties, or function names to inspect their inferred
types and signatures. For example, `book.pages` shows `pages as number`, and
`labels` shows `labels as list of text`. Hovers use current editor buffers,
including unsaved changes, and need the project's TypeScript and Workspace Trust.
Set `prose.hover.enabled` to `false` to disable them.

Use **Go to Definition** (`F12` or `Ctrl+click`) on a variable, parameter, or
function name to jump to its declaration. Imported Prose functions open their
original `.prose` file, including changes in unsaved buffers. Reassigned variables
jump to their first assignment. This shares the hover service's TypeScript and
Workspace Trust requirements; `prose.definition.enabled` controls it separately.

## Formatting

The formatter standardizes indentation and spacing while keeping your line breaks
and continuation indentation whenever every physical line of a statement or header
fits the width. It reflows a logical line only when one of its physical lines is too
long. Its default width is 80 columns:

```powershell
node bin/prose.js format examples/reading_list.prose --width 80
node bin/prose.js format src --check
npm.cmd run format -- examples/fizzbuzz.prose
```

Files and folders are accepted; folders are searched recursively, skipping
hidden entries and `node_modules`. Formatting updates files in place. `--check`
reports files that would change and exits with status 1 without writing them.
Already formatted files are left alone. A syntax error stops the batch before
any files are written; unfinished design sketches need valid syntax first.
Layout errors include an explanation and example; see
[wrapping lines and reading layout errors](docs/line-wrapping.md).

When a function header needs reflowing, each parameter gets its own indented line,
with a trailing comma, and `giving` returns to the header's indentation:

```text
export function create_note_tags takes
    body as text,
    title as maybe text,
    labels as maybe list of text,
giving list of DatumTag
```

A header that fits on one line stays there. Without `giving`, the last parameter
has no trailing comma, so the function body starts separately. Long conditions
and conditional values use the layouts below. Other long lines
prefer breaks after `or` / `otherwise`, then `and`, then a lambda's `return`, then
commas between outer call arguments or object entries. Nested calls and opening
parentheses stay together when a looser break works. These continuation lines
use one extra indentation level from the statement's first line.

Conditions in `if`, `else if`, and `while` may also continue with leading `and`
or `or`, aligned with the header or indented farther. The body remains deeper
than the first header line:

```text
if number < 0
or number >= 10
    print "Outside the range"
```

These breaks keep the usual precedence and short-circuit behavior. When a condition
needs reflowing, the formatter prefers leading `and` / `or`, aligned with its header.
Operators inside parentheses use continuation indentation. A very narrow width may
require a break after an operator instead. Fitting layouts retain their breaks.
A leading operator cannot continue a condition after its body has started.

When a trailing conditional value needs reflowing, its `if` and `else` clauses each
start a new line, one indentation level deeper than the statement:

```text
labels is books.map function takes book
    return book.title + " (long)"
        if book.pages > 500
        else book.title
```

Long conditions within these clauses also prefer leading `and` / `or`, aligned
with the `if`. This layout works for returns, assignments, `print`, and object
property values. Parentheses and function bodies keep their existing boundaries.
Conditional values inside inline `then` bodies keep continuation breaks compatible
with the enclosing header.

The formatter keeps strings, patterns, parentheses, and the choice of `.` or `:`.
It reparses the result and checks that the program's structure and documentation
are unchanged. Strings, long names, and expressions without a safe break may
exceed the requested width. Existing LF or CRLF line endings are retained.

For a preview, use standard input; `--stdin-filepath` resolves Prose imports
relative to the named file:

```powershell
Get-Content -Raw examples/reading_list.prose |
    node bin/prose.js format - --stdin-filepath examples/reading_list.prose
```

In VS Code, use **Format Document** (`Shift+Alt+F` on Windows). The extension
uses the same formatter, follows the editor's indentation settings, and accepts
`"prose.format.width": 80`. Formatting does not enable format-on-save; that
remains an editor preference. The formatter reads imported Prose signatures
without running any program code.

From JavaScript, import `format` from `prose-lang/format` (or `./src/format.js`
inside this repository) and call `format(source, { width: 80, readModule })`.
As with the compiler, `readModule(path)` supplies the text of imported Prose
files when their function signatures are needed.

## Source maps and debugging

`node bin/prose.js program.prose --run` enables source maps automatically.
Runtime errors show stack frames pointing to the original `.prose` files,
including imported modules and asynchronous functions. Syntax errors retain
their short file-and-line messages.

JavaScript printed by the CLI includes an inline source map with the original
Prose text. To use it after saving the output, enable Node's source-map support:

```powershell
node bin/prose.js examples/fizzbuzz.prose > fizzbuzz.js
node --enable-source-maps fizzbuzz.js
```

The Vite plugin returns maps for each transformed Prose file. Vite can compose
them with later transforms; use `build: { sourcemap: true }` to include maps in
a production build. In the playground, a runtime error displays its Prose line
and column, with the mapped stack trace in Output. Browser developer tools can
also read the worker program's inline map.

The compiler API accepts `sourceMap: true` to return a separate map, or
`sourceMap: "inline"` to append it to the JavaScript as well:

```javascript
const { code, map } = compile(source, {
    filename: "notes.prose",
    sourceMap: true
});
```

Maps follow [ECMA-426](https://tc39.es/ecma426/) and are off by default in the
compiler API (`map` is then `null`). They include
the original source and locations at statement and expression starts, including
continuation lines. Generated runtime helpers and local declarations remain
unmapped. Debugger breakpoints use the Prose locations; debugger locals still
use the generated JavaScript bindings.

If registering the Node loader yourself, start Node with `--enable-source-maps`
or call `process.setSourceMapsEnabled(true)` before importing Prose files.

## Landing page

The source of the Prose landing page, including a playground that runs this
compiler in the browser, is in [site/](site/README.md). `npm.cmd run site`
builds it to `site/dist/index.html`.

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
- Inline conditionals such as `if number < 2 return 1`, optionally with `then`.
- One-based Unicode string indexing and single-character indexed assignment.
- Standard-library `length`, `char_to_number`, and `number_to_char`.
- Standalone string expressions as comments, and unset variable declarations.
- Object literals, indented or on one line (`object kind is "none", count`), copying
  another object's properties with `like`, and `:` property access and assignment.
- Comma-separated arrays with one-based indexing, shared by reference like objects.
- `each of` to spread a collection into a list or a call, and `are` to assign
  several names from a list: `first, second are pair`.
- `for each item in items`, including several variables for pairs: `for each name, count in counts`.
- `skip` and `stop` to continue or leave a loop.
- Regular expressions written `pattern "^\d+$"`, with flag words such as `everywhere`.
- Inline `if ... then ... else ...` values, the `unset` value, and the `otherwise` fallback operator.
- Functions as values, with inline (`function takes x return x * 2`) or indented bodies.
- JavaScript globals, methods, and `new`: a value followed by arguments is a
  call (`items:join ", "`), and `run` calls with none.
- `maybe`, which reads through values that might be unset or `null`.
- Type tests (`value is a text`, `reason is an Error`), `try` with `on error`,
  `fail` to raise an error, and `wait for` a promise.
- Bit operators `xor`, `shifted left by`, and `shifted right by`.
- Computed property names: `settings:(name)`.
- Modules: `use name from "path"` and `export`, plus a Vite plugin. Functions
  imported from other `.prose` files keep their argument counts.
- Compile-time errors for names that are never assigned, imported, or provided
  by JavaScript, and for calls whose arguments could be read two ways.
- Optional type annotations that generate TypeScript declaration files.

```text
total is 0
for number is 1 to 5
    total is total + number
if total = 15
    print "It works!"
else
    print total
```

Multiplication, division, remainder, `mod`, and the bit operators bind tighter
than addition and subtraction, followed by comparisons (and `is a` tests),
`not`, `and`, then `or`.
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

print multiply 2, (3 + 4)
print (multiply 2, 3) + 4
```

These print `14` and `10`, respectively. With several arguments, arithmetic
right after the last one could belong to it or to the call's result, so
`multiply 2, 3 + 4` is a syntax error, as it is for JavaScript calls. A call
consumes the declared number of arguments. This also applies to function values,
aliases, and callbacks with a known function type. Nested calls follow the same
rule; parentheses make grouping explicit.
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
JavaScript string methods use UTF-16 offsets instead; see the
[Prose and JavaScript conventions](docs/javascript-interop.md) guide for examples.

- Missing reads return unset (`undefined` in emitted JavaScript).
- A write replaces an existing position or appends at `length + 1`.
- Writes cannot skip positions or use a non-positive or fractional index.
- Each indexed write replaces exactly one code point; a multi-character
  replacement is an error.
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

### Spreading and taking apart

`each of` spreads a list, string, or other collection into a list, a call's
arguments, or `print`:

```text
rest is 2, 3
all_items is 1, each of rest, 4
print Math:max each of all_items
```

These make `1, 2, 3, 4` and print `4`. Prose's own functions take a fixed
number of arguments, so `each of` can't spread into them.

`are` assigns several names at once, from a list's items in order:

```text
first, second are pair
r, g, b are (255, 128, 0)
a, b are b, a
```

The last line swaps `a` and `b`. Like `for each name, score in scores`, it
works with any collection, including strings and `Map` entries.

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

`skip` moves on to the loop's next turn, and `stop` leaves the loop. Both apply
to the innermost `for`, `for each`, or `while` loop in the same function:

```text
for each datum in datums
    if datum:time < since skip
    if length found = 10 stop
    found:push datum
```

## Patterns

`pattern "..."` is a regular expression. Its text is kept exactly as typed,
so `\d` and `\s` need no extra backslashes; write `\"` for a quote. Flag words
may follow it: `everywhere` finds every match, `ignoring case` matches either
case, and `by line` makes `^` and `$` match at each line. Patterns always treat
emoji and other characters beyond the basic set as single characters, matching
how Prose counts positions.

```text
if text:match pattern "^\d{4}$" then print "a year"
clean is name:replace with (pattern "\s*\([^()]*\)$"), ""
tags is note:match pattern "#(\p{L}+)" everywhere
```

A pattern that isn't a valid regular expression is a syntax error on its line.
`pattern` means this only when a quoted string follows it, so it still works as
part of other names, like `pattern_count`.

## Inline if, unset, and otherwise

`if condition then value else other` chooses a value inside an expression.
The value can also come first: `value if condition else other`.

```text
function status takes book
    return "read" if book.done else "to read"

label is "one" if count = 1 else "many"
```

The trailing form requires `else`. Calls, arithmetic, and logic bind before
it: `describe book if book.done else "to read"` chooses between the result of
`describe book` and `"to read"`. The condition runs first, followed by only the
selected branch. Use parentheses to pass a trailing conditional as an argument
or to nest trailing conditionals:

```text
print format ("read" if book.done else "to read")
label is "first" if first else ("second" if second else "neither")
```

Continuation lines can break before or after `if` and `else`, with greater
indentation than the expression's first line:

```text
labels is books.map function takes book
    return book.title + " (long)"
        if book.pages > 500
        else book.title
```

The same layout works for assignments, `print`, and object property values.
An `if` aligned with the preceding statement remains a block statement. Function
bodies and block `else` clauses keep their existing indentation rules. Formatting
preserves these breaks when they fit the width. The trailing form still requires
`else`, and nested trailing conditionals still need parentheses.

The prefix form's `else` part extends as far right as it can, so wrap that inline `if`
in parentheses when more of the expression follows:

```text
label is count + " " + (if count = 1 then "entry" else "entries")
```

`unset` is the missing value (JavaScript `undefined`). `value otherwise
fallback` gives `fallback` when `value` is unset or `null`, and `value`
otherwise; unlike `or`, it keeps `0`, `""`, and `false`.

An inline `if` statement may put `then` before its body: `if n < 2 then return 1`.
`then` is required when the condition ends in a call and the body starts with
a name, because `if ready count is 5` would read `ready count` as a call. The
compiler says so; write `if ready then count is 5`. A `then` at the end of the
line can also introduce an indented body.

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

## Type tests, errors, and waiting

`is a` (or `is an`) tests what kind of value something is, and `is not a`
tests the opposite. Values read from storage or a file are usually checked
this way before they're used:

```text
function parseGoal takes stored
    if stored is not an object return unset
    if stored:value is not a number return unset
    return object direction is stored:direction, value is stored:value
```

The kinds are `text`, `number`, `boolean`, `function`, `list`, and `object`
(something with properties: not `null`, a list, or a function). A capitalized
name tests for a class instead, as JavaScript's `instanceof` does:
`reason is an Error`, `day is a Date`. At the start of a line, `name is a ...`
is still an assignment; type tests go where a value is expected, such as an
`if` line or the right side of `is`.

`fail` stops with an error. A message becomes an `Error` with that message,
and an `Error` (such as one caught below) is raised as it is. `try` runs its
indented lines, and if anything in them fails, the `on error` block after it
runs instead of the rest. A name after `on error` holds what failed:

```text
function checked takes amount
    if amount < 0 fail "Amounts can't be negative."
    return amount

try
    stored is JSON:parse text
on error problem
    print problem:message
    stored is unset
```

Variables assigned in either block belong to the surrounding function, and
`skip` and `stop` still work in a loop around the `try`.

`wait for` waits for a promise and gives its result. A function or function
value that waits for something becomes asynchronous: calling it gives a
promise, and its generated declaration gives `Promise of` its result type.

```text
function loadNotes takes url as text, giving list of text
    response is wait for fetch url
    return wait for response:json run
```

The bit operators work on 32-bit integers as JavaScript's do: `a xor b` is
`a ^ b`, `a shifted left by n` is `a << n`, and `a shifted right by n` is
`a >>> n`, which fills with zeros, so its result is never negative.

## Functions as values

`function` without a name makes a function value. With `return` on the same
line, everything after `return` (up to a comma that ends an argument) is the
result. Without `return`, the function's body is the indented lines that follow:

```text
doubled is values:map function takes value return value * 2

labels is books:map function takes book
    if book:pages > 500 return book:title + " (long)"
    return book:title
```

A function with an indented body can appear anywhere on a line, including
before other arguments (`later with function, 5`), but only one per line, and
not in `if`, `while`, or `for` lines or inline conditionals. Call a function
value by putting its arguments after it (`shout "hi"`), or `run` when it takes none.

Named functions and function values use the same argument boundaries:

```text
function add takes left, right
    return left + right

add_value is function takes left, right return left + right
alias is add_value
print add 1, 2, 3
print add_value 1, 2, 3
print alias 1, 2, 3
```

All three print `[3, 3]`: the two-argument call finishes before the last comma.
A named function can also be used as a value (`alias is add`). A function type
supplies the same boundary for a callback:

```text
function apply takes action as function taking number and number giving number
    return action 1, 2, 3
```

Inference uses all assignments to a binding in its function or program scope,
including branches and loops. Implementations with the same parameter count
keep that count. Different counts, an untyped parameter, or a value whose
signature cannot be proved leave the count unknown. Reassignment is allowed;
Prose does not guess boundaries from a runtime function's `length`.

An unknown-count call can take one argument or use `run`. A comma requires an
explicit boundary: `action with 1, 2` passes two arguments, while `(action 1), 2`
is an array containing a one-argument call and `2`. For a two-argument call
followed by an array element, write `(action with 1, 2), 3`. Parentheses alone
can contain an array, so `(action 1, 2)` still needs `with`. These are parsing
rules; whether the arguments have valid types is checked separately.

Function values can read the variables around them. Like named functions,
assigning a name inside one creates a local: it does not change an outer
variable with the same name. Changing an outer array or object (for example,
`seen:push value`) does affect it.

## Using JavaScript

The [Prose and JavaScript conventions](docs/javascript-interop.md) guide compares
positions, Unicode lengths, contextual dots, explicit colons, and literal JSON
keys. VS Code hovers explain these boundaries at the relevant access or call.

When no Prose variable has the name, common JavaScript globals are available:
`Math`, `JSON`, `Object`, `Array`, `Map`, `Set`, `Date`, `Number`, `String`,
`Promise`, `console`, `document`, `window`, `localStorage`, `fetch`, and more.

A name, property, position, or parenthesized value followed directly by a
value is a call. For an unknown parameter count, use `with` before multiple
arguments. `run` calls with no arguments. Create objects with `new`:

```text
print name:toUpperCase run
print words:join ", "
seen is new Set ("a", "b", "a")
print Math:max with 3, 9, 4
date is new Date with 2026, 0, 1
```

Prose cannot tell whether `items:pop` is a property or a method, or how many
arguments a JavaScript function takes, so these rules decide instead. `with`
also works with one argument (`words:join with ", "`), and can introduce a
negative first argument. Prose reads
`items:at -1` as ambiguous (the space before the minus but not after suggests
a negative number) and asks for `items:at with -1`, `items:at (-1)`, or a
spaced `items:at - 1` to subtract.

A `with` call takes every comma-separated value that follows it. An unknown
call without `with` followed by a comma is a syntax error. Two other places
where a call could be read two ways also require explicit parentheses:

- Arithmetic right after explicit arguments. `counts:set with key, count + 1`
  could add one to the count or to the call's result. Write
  `counts:set with key, (count + 1)` or `(counts:get key) + 1`.
- A call with several arguments inside another call's arguments.
  `outer with inner with 1, 2` could pass the `2` to either call.
  Write `outer with (inner with 1, 2)`.

Comparisons, `and`, `or`, and `otherwise` after a call apply to its result:
`counts:get key otherwise 0` and `localDateKey day = key` need no
parentheses. To call a method of a call's result, wrap the call in
parentheses: `(words:slice 1):join run`. Results of calls are not called again
by values after them; write `(make_adder 1) 2`.

Prose's own functions keep the call-first rule and take single values as
arguments, so `length rows + 1` means `(length rows) + 1`, and a call inside
their arguments needs parentheses: `twice (items:indexOf 5)`.

Because any variable can hold a function, a missing operator such as
`print total count` compiles as a call and fails when it runs: "Only functions
can be called."

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

Prose names are snake_case, and JavaScript's are camelCase. A name made of
lowercase words joined by underscores becomes camelCase wherever JavaScript
sees it: a property or method (`tag:name:to_locale_lower_case run` calls
`toLocaleLowerCase`), an object entry (`object is_today is true` has the
property `isToday`), a JavaScript global (`local_storage`), an import or
export (`export function same_tag_name` is `sameTagName` to JavaScript and
TypeScript), and the names in generated declarations. JavaScript's own names
that capitalize an acronym, such as `randomUUID` and `toISOString`, are
written `random_uuid` and `to_iso_string`. Other names, such as `Math`,
`NaN`, or `__proto__`, are used as they are. To use a property whose name
really has underscores, as in data from another program, write it as a
computed property: `record:("user_id")`.

## Long lines

A line continues on the lines after it that are indented more when it ends
with a comma, an operator (such as `+`, `and`, `or`, `otherwise`, or `is`),
`return`, or `takes`, or while a parenthesis is still open:

```text
ready is title and priority != "" and
    not (has_tag tags, "done")
total is (first_amount + second_amount +
    third_amount)
newest is entries:sort function takes left, right return
    right:time - left:time
```

A function header that doesn't fit on one line gives each parameter a line of
its own, with the `giving` line back at the header's indentation:

```text
export function create_note_tags takes
    body as text,
    title as maybe text,
    labels as maybe list of text,
giving list of DatumTag
    tags is array
```

The joined lines are read as one line. A block's body still starts on the
first line after its header that doesn't continue it, so indenting the rest
of an `if` line further than the body keeps them apart.
Comment lines in a row are one comment, so a long description above a
declaration can take several quoted lines.

## Modules and Vite

`use` imports names from a JavaScript or TypeScript module, and `export`
before a top-level `function` or assignment exports it:

```text
use addDays, dateFromKey from "../dates"

export function nextDay takes key
    return addDays (dateFromKey key), 1

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

Names imported from JavaScript or TypeScript are values: call them by
putting arguments after them, or with `run`. No imported name can be reassigned at the top level. A file
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
are recompiled. For TypeScript, generate a declaration file beside each Prose
file, such as `dates.d.prose.ts` (see [Types](#types)), and enable
`allowArbitraryExtensions` in `tsconfig.json`.

`compile(source, options)` returns `{ code, map, module, declarations }`; `transpile(source, options)`
returns only the code. Options:

- `runtime`: a module path to import the runtime helpers from instead of
  embedding them.
- `readModule(path)`: returns the source of an imported `.prose` file, for
  reading its exported functions. Compiling a file that imports one without
  this option is an error. The CLI and the Vite plugin provide it.
- `sourceMap`: `true` for a separate map, `"inline"` to embed it too, or `false`
  (the default) to omit it.
- `filename`: the original source path or URL recorded in a map; defaults to
  `program.prose`. The CLI and Vite plugin supply it automatically.
- `check`: `true` to generate TypeScript for type checking instead of executable
  JavaScript. See [Type checking](docs/type-checking.md).

To run `.prose` files in your own Node.js program, register the module hook in
`src/node-hooks.js` with `module.register`; the CLI's `--run` does this.

## Types

Annotations are optional and change nothing about how a program runs. They
describe a module's exports to TypeScript: the compiler turns them into a
declaration file (`text.d.prose.ts` beside `text.prose`), so TypeScript code
that imports the module is type-checked. The `check` command also checks Prose
function bodies using the project's TypeScript 5 or 6 and `tsconfig.json`:

```sh
node bin/prose.js check
node bin/prose.js check src
node bin/prose.js check src/notes.prose --project tsconfig.json --json
npm.cmd run check -- src
```

Diagnostics point to the original Prose file, line, and column. Checking keeps
fresh import declarations in memory and never runs the application or writes
files. Exit status is 0 for a clean check, 1 for source errors, and 2 for setup
errors. If TypeScript is missing, install it in the project with
`npm.cmd install --save-dev typescript`. See [Type checking](docs/type-checking.md)
for selection rules, JSON output, and current limits. The VS Code extension uses
the same checker on open and save; automatic build checks are still to come.

```text
use type Datum from "../types"

"1 entry, 3 entries. The plural defaults to the singular plus an s."
export function pluralize takes count as number, singular as text, plural as maybe text, giving text
    if plural = unset plural is singular + "s"
    return count + " " + (if count = 1 then singular else plural)

"A run of consecutive days."
export type StreakRun is object
    "First and last day, as YYYY-MM-DD."
    start as text
    end as text
    length as number

export week_length as number is 7
```

`as` follows a parameter or an exported variable; `giving` gives a function's
result type, after a comma when parameters come first. A quoted comment on the
line just above a declaration or field becomes its documentation.

| Prose | TypeScript |
| --- | --- |
| `text`, `number`, `boolean`, `any`, `unknown` | `string`, `number`, `boolean`, `any`, `unknown` |
| `nothing` (a result), `unset`, `null` | `void`, `undefined`, `null` |
| `"day"`, `7`, `true` | literal types |
| `list of T`, `set of T`, `map from K to V` | `T[]`, `Set<T>`, `Map<K, V>` |
| `(text, number)` | `[string, number]` |
| `A or B`, `maybe T` | `A \| B`, `T \| undefined` |
| `function taking A and B giving C` | `(arg1: A, arg2: B) => C` |
| `Name`, `Name of T`, `Name from K to V` | `Name`, `Name<T>`, `Name<K, V>` |
| `item`, `key` (other lowercase names) | type parameters, as in `groupBy<item, key>` |
| `object` | `object`, or an interface when `type X is object` has fields |

Parentheses group types: `list of (number or unset)`. With commas they make a
tuple, like Prose's own lists: `list of (text, number)` is a list of pairs. A trailing parameter that
is untyped or `maybe` may be left out by callers. List parameters are declared
read-only (`readonly T[]`), so TypeScript can pass read-only arrays to them.
A type inside a namespace is written with a colon: `Intl:DateTimeFormatOptions`. Field types written
`maybe T` make optional fields. `type Name is …` declares a type at the top
level; type names start with a capital letter. `use type A, B from "path"`
imports types for the declarations, from TypeScript or other Prose files.
Function values may be annotated too (`function takes n as number giving number
return n * 2`); the checker uses those annotations too.

Write or refresh the declaration files with the `types` command, and add
`--check` to fail when one is out of date:

```sh
node bin/prose.js types src
node bin/prose.js types src --check
```

The Vite plugin can also keep them current as files compile: `prose({ declarations: true })`.

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

Dot notation uses the receiver to choose between properties and positions.
On arrays and strings, a visible numeric variable supplies the index:
`people.i` selects position `i`. Other names remain literal. On ordinary objects,
bare names always select literal properties: `book.pages` reads the `pages`
field even when a numeric loop variable named `pages` is still in scope.
Explicit computed keys keep using their values, so `record.(key)` selects the
property named by `key`. An unset string can still begin with an indexed write.

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
A property's value can be a function value.

To use a property whose name is in a variable or worked out, put it in
parentheses after the colon. It reads and writes like any other property:

```text
counts is object
for each word in words
    counts:(word) is (counts:(word) otherwise 0) + 1
print counts:("the")
```

An object can also be written on one line, after `object`. Each entry is
`name is value`, a bare name (a property with that variable's name and value),
or `like other`, which copies another object's properties:

```text
return object text, labels
runs:push object start is key, end is key, length is 1
updated is object like tag, value is title
```

Later entries replace earlier ones, so `updated` is a copy of `tag` with a new
`value`. An indented body can also contain `like` lines. Like a call, a
one-line object takes every comma after it, so put it in parentheses when more
arguments or list items follow: `Array:from with (object length is 24), make_hour`.

Run `npm.cmd run example:objects` to try the example.

## Caesar cipher

Run `npm.cmd run example:cipher` to encode `hello` as `khoor`, decode it again,
and demonstrate wrapping in both directions. The cipher uses `mod 26`, so
negative rotations wrap too, and starts from an empty string, so empty input
returns `""`.

The example targets lowercase `a–z`: it applies that same mapping to every
input character. Case-preserving or punctuation-preserving behavior would
require additional branches in the example.

## More examples

`fibonacci.prose`, `factorial.prose`, and `caesar_cipher.prose` define functions
without calling them; each one's `_demo` file adds the calls. Run
`npm.cmd run example:factorial` to print both factorial implementations' answers
for each integer from 0 through 10 (two identical lines per input).

`reading_list.prose` demonstrates `for each`, function values, and JavaScript
methods; `habits.prose` adds `maybe` and imports between Prose files;
`tour.prose` covers everything. `MusicTicker.prose` is a design sketch that
doesn't compile.

Nested named functions and default imports aren't implemented. Unsupported
syntax produces a line-numbered error.

The library entry points are `compile` and `transpile` in `src/transpile.js`.
The implementation parses expressions and indentation into an AST, resolves
every name, then emits a standalone JavaScript script or an ES module.
