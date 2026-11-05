# Prose

**Code you can read aloud.**

Prose is a small programming language made of plain English words. It compiles
to ordinary JavaScript, so it runs anywhere JavaScript runs and works alongside
the code you already have.

```prose
function without takes refs, ref
    return refs:filter function takes item return
        chart_key item != chart_key ref
```

This function takes a chart out of a list. It comes from Datums, a personal log
app that's being converted to Prose, where it replaced this TypeScript:

```ts
const without = (refs: ChartRef[], ref: ChartRef) =>
  refs.filter((item) => chartKey(item) !== chartKey(ref))
```

Here are both as you'd dictate them, with every symbol in bold:

> function without takes refs **comma** ref return refs **colon** filter
> function takes item return chart key item **not equals** chart key ref

> const without **equals** **open paren** refs **colon** chart ref
> **open bracket** **close bracket** **comma** ref **colon** chart ref
> **close paren** **arrow** refs **dot** filter **open paren** **open paren**
> item **close paren** **arrow** chart key **open paren** item **close paren**
> **not double equals** chart key **open paren** ref **close paren**
> **close paren**

That's 3 symbols and 22 words, against 20 symbols and 51 words.

The TypeScript does say more. Four of its symbols are types, and they do a job:
`prose check` lets `without 1, 2` through until you add them back to the header.

```prose
function without takes refs as list of ChartRef, ref as ChartRef
```

## Goals

1. Read as close as possible to natural English.
2. Use as few non-letter characters as possible.
3. Transpile to JavaScript so I can use it.

## Try it

Prose is young, and it's still changing, so it isn't on npm yet. You need
Node.js 20.19 or newer, and there's nothing else to install:

```sh
git clone https://github.com/travisk-codes/prose-lang.git
cd prose-lang
node bin/prose.js examples/tour.prose --run
```

That runs [a tour](examples/tour.prose) of every feature, section by section.
Save your own program in a `.prose` file and run it the same way, or leave off
`--run` to see the JavaScript it compiles to.

## A short tour

`is` stores a value and `=` compares. Indentation makes blocks.

```prose
total is 0
for each price in 3, 4, 5
    total is total + price

if total = 12
    print "It adds up."
```

Functions say what they take, and a call is a name with values after it. **A
call takes every comma after it, and parentheses end it early.**

```prose
function add takes left, right
    return left + right

print add 1, 2
print add 1, (add 2, 3)
print (add 1, 2), 3
```

A call with one argument finishes before an operator, which is why
`chart_key item != chart_key ref` needs no parentheses. This doesn't depend on
what's being called, so an edit to another file can't change how a line reads.
Where a line could be read two ways, the compiler asks instead of guessing:

```text
Line 3: '+' right after a call's arguments is ambiguous. Put the last argument
in parentheses to include it, or the whole call to use its result.
```

Positions start at 1, and an emoji is one character. This prints `😀` and `3`:

```prose
word is "a😀z"
print word.2
print length word
```

Reading through something missing stops with the line number, unless you write
`maybe`:

```prose
city is maybe person:address:city otherwise "unknown"
```

Functions are values, so they go straight into JavaScript methods. Lists and
objects are JavaScript's own, and `use` imports from JavaScript and TypeScript.
Prose names are snake_case, and JavaScript sees them as camelCase. JavaScript's
methods keep their own rules, including positions that start at 0.

```prose
use add_days, date_from_key from "./dates.js"

export function next_day takes key
    return add_days (date_from_key key), 1

long_books is books:filter function takes book return book:pages > 500
```

Types are optional. Add `as` and `giving` where they help, and Prose writes the
TypeScript declaration file for you. Leave them out and everything still runs.

```prose
export function pluralize takes
    count as number,
    singular as text,
    plural as maybe text,
giving text
    if plural = unset plural is singular + "s"
    return count + " " + (if count = 1 then singular else plural)
```

HTML-style tags compile to React calls, with Prose inside the braces:

```prose
export function SaveButton takes props
    return <button disabled={props.saving} on_click={props.on_save}>
        {"Saving…" if props.saving else "Save"}
    </button>
```

## Tools

| Tool | What it does |
| --- | --- |
| [`prose check`](docs/type-checking.md) | Checks Prose with your project's TypeScript, with errors on the original lines |
| [`prose format`](docs/tools.md#formatting) | Formats files, keeping your line breaks wherever they fit |
| [`prose types`](docs/guide.md#types) | Writes TypeScript declarations, so TypeScript that imports Prose is checked |
| [Vite plugin](docs/tools.md#vite) | Compiles `.prose` files as they're imported, including in Vitest |
| [VS Code extension](editors/vscode/README.md) | Highlighting, errors, autocomplete, hover types, rename, formatting, running, and debugging |
| [Source maps](docs/tools.md#source-maps-and-debugging) | Runtime errors and breakpoints point at your Prose |

From a clone, `prose` is `node bin/prose.js`.

## Learn more

- [The guide](docs/guide.md) covers the whole language.
- [Tools](docs/tools.md) covers the command line, formatter, debugging, Vite, and
  the compiler API.
- [Example programs](examples/README.md) run from the repository root.
- [Prose and JavaScript](docs/javascript-interop.md) compares their conventions
  for positions, text, and property names.
- [The grammar](docs/grammar.md) is the formal reference.
- [The landing page](site/README.md) has a playground that runs the compiler in
  your browser. `npm install`, then `npm run site`, builds it to
  `site/dist/index.html`.

[CONTRIBUTING.md](CONTRIBUTING.md) has the development commands,
[CHANGELOG.md](CHANGELOG.md) the release notes, and [SECURITY.md](SECURITY.md)
the trust model. Prose is under the [MIT license](LICENSE).
