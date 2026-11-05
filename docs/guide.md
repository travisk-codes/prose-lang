# The Prose guide

This is the whole language as it stands today, in the order you'd learn it. The
[README](../README.md) is the short version, and [the grammar](grammar.md) is the
formal one. [Tools](tools.md) covers running, formatting, and debugging.

- [Values and operators](#values-and-operators)
- [Blocks and loops](#blocks-and-loops)
- [Inline if, unset, and otherwise](#inline-if-unset-and-otherwise)
- [Functions](#functions)
- [Functions as values](#functions-as-values)
- [Text and positions](#text-and-positions)
- [Lists](#lists)
- [Objects](#objects)
- [maybe](#maybe)
- [Patterns](#patterns)
- [Type tests, errors, and waiting](#type-tests-errors-and-waiting)
- [Names](#names)
- [Using JavaScript](#using-javascript)
- [Long lines](#long-lines)
- [Modules](#modules)
- [React markup](#react-markup)
- [Types](#types)
- [Not supported](#not-supported)

## Values and operators

`is` stores a value, and `print` shows one:

```prose
answer is 42
print answer
```

The literal values are numbers, double-quoted strings with JSON escapes, `true`,
`false`, and `null`. A string on its own line is a comment: its value is thrown
away, so `"This is a comment"` does nothing.

| Kind | Operators |
| --- | --- |
| Arithmetic | `+`, `-`, `*`, `/`, `%`, `mod`, and unary minus |
| Comparison | `=`, `!=`, `<`, `>`, `<=`, `>=`; equality is strict |
| Logic | `not`, `and`, and `or`, which short-circuit |
| Bits | `xor`, `shifted left by`, and `shifted right by` |
| Fallback | [`otherwise`](#inline-if-unset-and-otherwise) |

Parentheses group.

Multiplication, division, remainder, `mod`, and the bit operators bind tighter
than addition and subtraction, followed by comparisons (and `is a` tests),
`not`, `and`, then `or`.
Operators at the same precedence associate left to right. Strings and numbers
use JavaScript arithmetic behavior; division can produce fractions.

`mod` is mathematical modulo: `-1 mod 26` gives `25`. Its result has the
divisor's sign (or is zero); the divisor must be nonzero and both operands must
be finite numbers. `%` and the prefix form `remainder number divisor` keep
JavaScript remainder behavior: `-1 % 26` gives `-1`.

The bit operators work on 32-bit integers as JavaScript's do: `a xor b` is
`a ^ b`, `a shifted left by n` is `a << n`, and `a shifted right by n` is
`a >>> n`, which fills with zeros, so its result is never negative.

## Blocks and loops

`if`, `else if`, and `else` take indented bodies. `for number is 1 to 5` counts
up, including both ends, and `while` checks its condition before each turn.

```prose
total is 0
for number is 1 to 5
    total is total + number
if total = 15
    print "It works!"
else
    print total
```

Use consistent indentation. A tab counts as four spaces; blank lines are
ignored. Each body must be indented beyond its header. Variables are script
scoped at the top level and local inside functions.
Assignment inside a conditional or loop updates the containing scope's variable.
Each function invocation gets its own locals; assigning a name inside a function
creates a local even if a global has the same name. Parameters can be reassigned.
For-loop upper bounds are evaluated once on entry, and the iterator advances by one.
A while-loop condition is reevaluated before every iteration, so an initially
false condition skips the body entirely. Assignments in its body persist in the
containing scope, and `return` exits the containing function.

```prose
number is 3
while number > 0
    print number
    number is number - 1
```

This prints `3`, `2`, then `1`.

### Loops over collections

`for each` visits the elements of an array, the characters of a string (by
code point), or the values of any other JavaScript collection. A comma list
works directly, and several variables take apart pairs, such as the entries
of a `Map`:

```prose
for each value in 2, 3, 5
    print value

for each name, score in scores
    print name + ": " + score
```

As with `for`, the loop variables belong to the surrounding function or
script and keep their last values after the loop.

`skip` moves on to the loop's next turn, and `stop` leaves the loop. Both apply
to the innermost `for`, `for each`, or `while` loop in the same function:

```prose
for each datum in datums
    if datum:time < since skip
    if length found = 10 stop
    found:push datum
```

## Inline if, unset, and otherwise

`if condition then value else other` chooses a value inside an expression.
The value can also come first: `value if condition else other`.

```prose
function status takes book
    return "read" if book.done else "to read"

label is "one" if count = 1 else "many"
```

The trailing form requires `else`. Calls, arithmetic, and logic bind before
it: `describe book if book.done else "to read"` chooses between the result of
`describe book` and `"to read"`. The condition runs first, followed by only the
selected branch. Use parentheses to pass a trailing conditional as an argument
or to nest trailing conditionals:

```prose
print format ("read" if book.done else "to read")
label is "first" if first else ("second" if second else "neither")
```

Continuation lines can break before or after `if` and `else`, with greater
indentation than the expression's first line:

```prose
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

```prose
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

## Functions

`function` declares a function, and `return` gives its result:

```prose
function fibonacci takes number
    if number < 2 return 1
    previous is fibonacci (number - 1)
    previous_again is fibonacci (number - 2)
    return previous + previous_again

print fibonacci 10
```

This prints `89`, preserving the example's base cases of 1 for both 0 and 1.
Run `npm run example:fibonacci` to print the first eleven values.

**Without parentheses, apply the function first, then continue the surrounding
expression.** For example, `fibonacci number - 1` means
`fibonacci(number) - 1`. Write `fibonacci (number - 1)` to subtract before the call.
Parentheses can also group the result: `(fibonacci number) - 1`.
Indexing binds before calls: `char_to_number word.i` means
`char_to_number (word.i)`. Normal arithmetic precedence still applies outside calls.

Functions declare their arguments with `takes`; calls separate arguments with
commas. Compound arguments need parentheses:

```prose
function multiply takes left, right
    return left * right

print multiply 2, (3 + 4)
print (multiply 2, 3) + 4
```

These print `14` and `10`, respectively. With several arguments, arithmetic
right after the last one could belong to it or to the call's result, so
`multiply 2, 3 + 4` is a syntax error. A call takes every comma after it, as
described below, and parentheses end it early. Leaving out an argument is a
syntax error unless `with` says it's intended: `multiply with 2` leaves `right`
unset.

Declare a zero-argument function with `function greet` and call it with
`greet run`. Calls can appear as standalone statements or inside expressions.

A call can also list its arguments after `with`. This form may leave trailing
arguments out; they arrive unset, which allows optional parameters:

```prose
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

### Calls and commas

**A call takes every comma after it. Parentheses end it early**, and any other
commas form an array:

```prose
function combine takes first, second
    return first + second

result is combine "Ada", "Grace"

function double takes number
    return number * 2

results is (double 2), (double 3)
```

`result` is `"AdaGrace"`; `results` is the array `4, 6`. Without the parentheses,
`double 2, double 3` passes everything to the first `double`, which takes one
argument, so it's an error. The same goes for a call that isn't last in another
call's arguments: write `combine (double 2), 3`. `length`, `char_to_number`, and
`number_to_char` always take one value, so `length a, length b` is an array.

Because this rule doesn't depend on what's being called, a line means the same
thing whatever it calls, and an edit to another file can never change it.

## Functions as values

`function` without a name makes a function value. With `return` on the same
line, everything after `return` (up to a comma that ends an argument) is the
result. Without `return`, the function's body is the indented lines that follow:

```prose
doubled is values:map function takes value return value * 2

labels is books:map function takes book
    if book:pages > 500 return book:title + " (long)"
    return book:title
```

A function with an indented body can appear anywhere on a line, including
before other arguments (`later function, 5`), but only one per line, and
not in `if`, `while`, or `for` lines or inline conditionals. Call a function
value by putting its arguments after it (`shout "hi"`), or `run` when it takes none.

Named functions and function values are called the same way:

```prose
function add takes left, right
    return left + right

add_value is function takes left, right return left + right
alias is add_value
print add 1, 2
print add_value 1, 2
print alias 1, 2
print (add 1, 2), 3
```

The first three print `3`. The last prints `[ 3, 3 ]`: parentheses end the call
before the last comma. A named function can also be used as a value
(`alias is add`).

Methods work the same way, with `.` or `:`:

```prose
calculator is object
    add is function takes left, right return left + right

print calculator.add 2, 3
results is (calculator.add 2, 3), 9
```

This prints `5` and assigns `[5, 9]` to `results`. Literal computed keys such as
`calculator.("add")` work too. See
[object_methods.prose](../examples/object_methods.prose) for a runnable example.

Objects exported from a `.prose` module work the same way in importers, and can
be forwarded through further modules:

```prose
use calculator from "./object_method_tools.prose"
export math is calculator
```

Consumers can then call `math.add 2, 3`. See
[imported_object_methods.prose](../examples/imported_object_methods.prose).

Prose checks how many arguments a function declared in Prose receives, but that
only reports mistakes; it never changes how a line reads. For function values and
JavaScript, `prose check` reports a wrong count when the types are known.

Function values can read the variables around them. Like named functions,
assigning a name inside one creates a local: it does not change an outer
variable with the same name. Changing an outer array or object (for example,
`seen:push value`) does affect it.

## Text and positions

String positions start at **1**. A dot accesses the position given by a number
or variable; parentheses group a calculated index:

```prose
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
[Prose and JavaScript conventions](javascript-interop.md) guide for examples.

- Missing reads return unset (`undefined` in emitted JavaScript).
- A write replaces an existing position or appends at `length + 1`.
- Writes cannot skip positions or use a non-positive or fractional index.
- Each indexed write replaces exactly one code point; a multi-character
  replacement is an error.
- Strings are values: indexed assignment creates the updated string for that
  variable; copies and the caller's string are unchanged.

A bare variable name or an assignment without a value initializes an unset
variable. The first indexed write at position 1 makes it a string:

```prose
result
alternative is
result.1 is "a"
alternative.1 is "b"
empty_string is ""
```

The first standard-library functions take one argument, using the same call
and grouping rules as user functions:

| Function | Behavior |
| --- | --- |
| `length value` | Number of Unicode code points in a string, or elements in an array |
| `char_to_number character` | Unicode code point of a single character |
| `number_to_char number` | Character for an integer code point from 0 to 1114111 |

These names cannot also be declared as variables, parameters, or user functions.
Invalid inputs report an error with the original source line.

## Lists

Comma-separated values make a list, which is a JavaScript array:

```prose
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

```prose
scalar is ("Ada")
single is ("Ada",)
empty is array
nested is (1, 2), (3, 4)
print (nested.1).2
```

For nested numeric indexes, use parentheses as above or `nested.(1).2`.
`nested.1.2` contains the decimal number `1.2`, so it is not a chain of
two integer indexes. Variable indexes can chain directly: `nested.i.j`.

To pass one array argument, put the entire array in parentheses:

```prose
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

```prose
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

Run `npm run example:arrays` to try array iteration and sharing.

### Spreading and taking apart

`each of` spreads a list, string, or other collection into a list, a call's
arguments, or `print`:

```prose
rest is 2, 3
all_items is 1, each of rest, 4
print Math:max each of all_items
```

These make `1, 2, 3, 4` and print `4`. Prose's own functions take a fixed
number of arguments, so `each of` can't spread into them.

`are` assigns several names at once, from a list's items in order:

```prose
first, second are pair
r, g, b are (255, 128, 0)
a, b are b, a
```

The last line swaps `a` and `b`. Like `for each name, score in scores`, it
works with any collection, including strings and `Map` entries.

## Objects

`object` makes an object, with its properties indented below it:

```prose
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

```prose
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

```prose
counts is object
for each word in words
    counts:(word) is (counts:(word) otherwise 0) + 1
print counts:("the")
```

An object can also be written on one line, after `object`. Each entry is
`name is value`, a bare name (a property with that variable's name and value),
or `like other`, which copies another object's properties:

```prose
return object text, labels
runs:push object start is key, end is key, length is 1
updated is object like tag, value is title
```

Later entries replace earlier ones, so `updated` is a copy of `tag` with a new
`value`. An indented body can also contain `like` lines. Like a call, a
one-line object takes every comma after it, so put it in parentheses when more
arguments or list items follow: `Array:from (object length is 24), make_hour`.

Run `npm run example:objects` to try the example.

## maybe

Reading a property of unset or `null` is an error, which points at the line
where something unexpectedly went missing. When a value may legitimately be
missing, put `maybe` before the chain that reads it: if any `:` property,
`.` position, or call in the chain meets unset or `null`, the whole chain is
unset instead.

```prose
city is maybe person:address:city otherwise "unknown"
maybe input:focus run
maybe on_close run
```

`maybe` covers the chain directly after it, so `maybe a:b + c:d` checks only
`a:b`. A call's arguments are evaluated only if there is something to call.
Calling a value that exists but is not a function is still an error.

## Patterns

`pattern "..."` is a regular expression. Its text is kept exactly as typed,
so `\d` and `\s` need no extra backslashes; write `\"` for a quote. Flag words
may follow it: `everywhere` finds every match, `ignoring case` matches either
case, and `by line` makes `^` and `$` match at each line. Patterns always treat
emoji and other characters beyond the basic set as single characters, matching
how Prose counts positions.

```prose
if text:match pattern "^\d{4}$" then print "a year"
clean is name:replace (pattern "\s*\([^()]*\)$"), ""
tags is note:match pattern "#(\p{L}+)" everywhere
```

A pattern that isn't a valid regular expression is a syntax error on its line.
`pattern` means this only when a quoted string follows it, so it still works as
part of other names, like `pattern_count`.

## Type tests, errors, and waiting

`is a` (or `is an`) tests what kind of value something is, and `is not a`
tests the opposite. Values read from storage or a file are usually checked
this way before they're used:

```prose
function parse_goal takes stored
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

```prose
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

```prose
function load_notes takes url as text, giving list of text
    response is wait for fetch url
    return wait for response:json run
```

At the top level, `wait for` needs a module file (one with a value `use` or
`export`); otherwise put it inside a function.

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

## Using JavaScript

The [Prose and JavaScript conventions](javascript-interop.md) guide compares
positions, Unicode lengths, contextual dots, explicit colons, and literal JSON
keys. VS Code hovers explain these boundaries at the relevant access or call.

When no Prose variable has the name, common JavaScript globals are available:
`Math`, `JSON`, `Object`, `Array`, `Map`, `Set`, `Date`, `Number`, `String`,
`Promise`, `console`, `document`, `window`, `localStorage`, `fetch`, and more.

A name, property, position, or parenthesized value followed directly by a
value is a call, and it takes every comma after it. `run` calls with no
arguments. Create objects with `new`:

```prose
print name:to_upper_case run
print words:join ", "
seen is new Set ("a", "b", "a")
print Math:max 3, 9, 4
date is new Date 2026, 0, 1
```

Methods take commas like any other call. Keep compound arguments in parentheses:

```prose
counts is new Map
counts.set "hello", 1
counts.set "hello", (counts.get "hello" + 1)
print counts.get "hello"
```

`run` is still required for zero-argument calls such as `counts.clear run`.

`with` is optional before a call's arguments (`words:join with ", "`), and can
introduce a negative first argument. Prose reads `items:at -1` as ambiguous (the
space before the minus but not after suggests a negative number) and asks for
`items:at with -1`, `items:at (-1)`, or a spaced `items:at - 1` to subtract.

Two places where a call could be read two ways require parentheses:

- Arithmetic right after several arguments. `add 1, 2 + 3` could add three to
  the last argument or to the call's result. Write `add 1, (2 + 3)` or
  `(add 1, 2) + 3`.
- A call inside another call's arguments, when a comma follows it.
  `outer inner 1, 2` could pass the `2` to either call. Write
  `outer (inner 1, 2)` or `outer (inner 1), 2`.

Comparisons, `and`, `or`, and `otherwise` after a call apply to its result:
`counts:get key otherwise 0` and `local_date_key day = key` need no
parentheses. To call a method of a call's result, wrap the call in
parentheses: `(words:slice 1):join run`. Results of calls are not called again
by values after them; write `(make_adder 1) 2`.

A call with one argument finishes before an operator, whatever it calls, so
`length rows + 1` means `(length rows) + 1`.

Because any variable can hold a function, a missing operator such as
`print total count` compiles as a call and fails when it runs: "Only functions
can be called."

JavaScript methods keep their JavaScript behavior, including zero-based
positions: `words:slice 0, 2` takes the first two items, while `words.1`
reads the first item. `:` reads properties of any value except `null` and
unset, including strings (`name:length` is JavaScript's UTF-16 length; the
standard-library `length` counts code points). Property assignment requires
an object and runs JavaScript setters, so `document:title is "Hello"` changes
the page title.

## Long lines

A line continues on the lines after it that are indented more when it ends
with a comma, an operator (such as `+`, `and`, `or`, `otherwise`, or `is`),
`return`, or `takes`, or while a parenthesis is still open:

```prose
ready is title and priority != "" and
    not (has_tag tags, "done")
total is (first_amount + second_amount +
    third_amount)
newest is entries:sort function takes left, right return
    right:time - left:time
```

A function header that doesn't fit on one line gives each parameter a line of
its own, with the `giving` line back at the header's indentation:

```prose
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

## Modules

`use` imports names from a JavaScript or TypeScript module, and `export`
before a top-level `function` or assignment exports it:

```prose
use add_days, date_from_key from "../dates"

export function next_day takes key
    return add_days (date_from_key key), 1

export week_length is 7
```

When the path names a `.prose` file, the compiler reads that file's `export`
lines, so its functions are called just like this file's own:

```prose
use pluralize from "./text.prose"

print pluralize 2, "tag", "tags"
print pluralize with 3, "entry"
```

Names imported from JavaScript or TypeScript are values: call them by
putting arguments after them, or with `run`. No imported name can be reassigned at the top level. A file
with `use` or `export` compiles to an ES module. Exported names become camelCase,
so JavaScript sees `nextDay` and `weekLength`.

To compile `.prose` files as a Vite project imports them, see
[Vite](tools.md#vite).

## React markup

HTML-style tags are expressions in `.prose` files. They compile to ordinary
JavaScript calls to React's `createElement`; React must be installed in the
consuming project. The compiler adds the React import automatically. A Vite
project can use the existing Prose plugin alongside its React setup.

```prose
export function EmptyState takes props
    return <div class_name="empty-state">
        <h3>{props.title}</h3>
        <p>{props.detail}</p>
    </div>

export function SaveButton takes props
    return <button disabled={props.saving} on_click={props.on_save}>
        {"Saving…" if props.saving else "Save"}
    </button>
```

Braces contain **Prose expressions**. Lowercase tags name HTML or custom elements;
uppercase tags refer to components in scope, including imported components.
Nested tags, self-closing tags (`<EmptyState title="Nothing yet" />`), dotted
component names (`<UI.Card />`), and fragments (`<>...</>`) are supported.
Attribute names use the usual Prose conversion: `class_name` becomes `className`,
`on_click` becomes `onClick`, and `aria-label` and `data-id` stay as written.
A bare boolean attribute such as `disabled` means `disabled={true}`.

Use `{like expression}` to copy an object's properties into the attributes,
just as `object like` copies properties into an object:

```prose
no_autofill is object type is "search", auto_complete is "off"
view is <input {like no_autofill} placeholder="Find a tag…" />
```

Attributes are applied from left to right, so later attributes or spreads
override earlier ones. A spread keeps the object's existing property names and
copies its properties shallowly; the object itself stays unchanged.

```prose
rows is books.map function takes book
    return <li key={book.id}>{book.title}</li>
view is <ul>{rows}</ul>
```

Text follows JSX whitespace rules: indentation and blank lines disappear, and
nonempty text lines join with spaces. Same-line spaces are kept. For exact text,
write a Prose string inside braces, such as `{"line one\nline two"}` or `{" "}`.
Common entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`) and decimal or
hexadecimal Unicode entities work in text and quoted attributes. Other characters
can be written directly. Text and values are passed to React as children.

`prose check` uses the project's React types to check native attributes, component
props, children, and inline event callbacks. Add `as` contracts to component props
for useful checking. Completion, hover, navigation, and rename work in brace
expressions; component names can be renamed in both their opening and closing tags.
The formatter preserves authored markup layout and formats surrounding Prose.

For now, define callbacks with an indented body **before** the markup and pass
their names in braces. Single-expression inline callbacks work inside braces.
HTML comments and JSX's JavaScript comment syntax are not supported.
To pass a tag as a function argument, use `render (<Card />)` or
`render with <Card />`; this keeps ordinary `a < b` comparisons unambiguous.
See [react_components.prose](../examples/react_components.prose) for typed components.

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
npm run check -- src
```

Diagnostics point to the original Prose file, line, and column. Checking keeps
fresh import declarations in memory and never runs the application or writes
files. Exit status is 0 for a clean check, 1 for source errors, and 2 for setup
errors. If TypeScript is missing, install it in the project with
`npm install --save-dev typescript`. See [Type checking](type-checking.md)
for selection rules, JSON output, and current limits. The VS Code extension uses
the same checker on open and save; automatic build checks are still to come.

```prose
use type Datum from "../types"

"1 entry, 3 entries. The plural defaults to the singular plus an s."
export function pluralize takes
    count as number,
    singular as text,
    plural as maybe text,
giving text
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
Trailing `maybe` parameters are also optional in callback types, such as
`function taking text and maybe number giving nothing`. A `maybe` parameter
before a required parameter must still be supplied, using `unset` when absent.
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

### Generics

Lowercase names in type annotations are inferred generic type parameters. You can
also declare them explicitly after a function or type name with `of`:

```prose
function identity of item takes value as item, giving item
    return value

type Box of item is object
    value as item
```

An optional `as` bound restricts a type parameter while retaining its specific
type throughout the declaration:

```prose
type TextOption of choice as text is object
    value as choice
    label as text

function identity of item as text takes value as item, giving item
    return value

print identity "Ada"
```

This emits `identity<item extends string>(value: item): item`. A numeric argument
is a type error. Named functions, inline functions, object types and type aliases
all support explicit parameters. Use commas for several parameters, for example
`of key as text, value`. Bounds can refer to another declared parameter.

Explicit lists name every type parameter owned by that declaration. Nested
functions can also use their outer function's parameters, or declare their own.
Names remain lowercase; uppercase type names refer to existing named types.
Declarations without `of` retain their existing inference behavior. Runtime
function calls still infer type arguments from values, such as `identity "Ada"`.
These declarations and bounds affect checking and generated TypeScript types;
the running JavaScript has no extra type arguments or runtime checks.

## Not supported

Nested named functions and default imports aren't implemented. Unsupported
syntax produces a line-numbered error.
[The grammar](grammar.md#9-not-in-the-grammar-unsupported) has the full list.
