# Prose: a concept programming language

```text
print "Hello world!"
```

## Goals

1. Read as close as possible to natural English.
2. Use as few non-letter characters as possible.
3. Transpile to JavaScript so I can use it.

## Try the first transpiler

Requires Node.js 20 or newer. The compiler has no runtime dependencies or installation step. On Windows PowerShell, use `npm.cmd`
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
node bin/prose.js examples/fizzbuzz.prose --run
node bin/prose.js examples/fizzbuzz.prose > fizzbuzz.js
node fizzbuzz.js
```

The CLI writes JavaScript to standard output by default. Add `--run` to
execute it with Node.js. Run programs you trust; execution has ordinary Node.js
permissions.

## Syntax highlighting in VS Code

The language extension in `editors/vscode` registers `.prose` files as **Prose**
and uses your current theme for keywords, function declarations, parameters,
standard-library calls, strings, numbers, operators, and indexing. Standalone
quoted comments receive comment coloring.

Install `dist/prose-language-0.1.2.vsix` with **Extensions: Install from VSIX...**
or run:

```powershell
code.cmd --install-extension dist/prose-language-0.1.2.vsix --force
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
- Comma-separated arrays with recursive copy semantics and one-based indexing.

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

### Copy behavior

Assigning an array copies it and all nested arrays. Objects inside arrays
keep their existing reference behavior. Each occurrence of a nested array
gets its own copy. Array arguments passed to user functions are also copied,
so changing array elements in a function does not change the caller's array.

```text
original is 1, 2
copy is original
copy.1 is 99
print original.1
print copy.1
```

This prints `1` and `99`. Array-valued object fields and array elements are
copied on assignment too. An object element, however, still refers to the
same object after an array copy; changing that object's properties remains
visible through its aliases.

Unset variables still become strings when first written through an index.
Start with `items is array` to append arbitrary array elements.

Run `npm.cmd run example:arrays` to try array iteration and copying.

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

A missing property reads as unset. Reading or writing named properties on
`null`, unset, or a primitive value reports a line-numbered error. Object
properties can be added or replaced after construction; an unset value is
not automatically turned into an object.

Objects use JavaScript reference semantics: assigning an object to another
variable shares it, and property changes through an alias or function parameter
affect the same object. Property assignment mutates the object and does not
declare a new variable in the function. String-valued properties retain the
existing Unicode indexing and append rules.

Object literals can be assigned to a variable or property, or returned from
a function with `return object` followed by indented property definitions.
Computed property names, methods, and inline object bodies within function
arguments are not implemented yet.

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
calls that exercise it. MusicTicker remains a design sketch. Methods, computed object keys, multiple print arguments, nested functions,
async, and JavaScript interop are not implemented yet. Unsupported syntax produces a line-numbered
error.

The library entry point is `transpile(source)` in `src/transpile.js`.
The implementation parses expressions and indentation into an AST, then emits
a standalone JavaScript script.
