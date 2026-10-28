# Prose examples

Run these from the repository root with Node.js; no package installation is
needed to run the compiler.

```powershell
node bin/prose.js examples/camp_budget.prose --run
node bin/prose.js examples/postcard_station.prose --run
node bin/prose.js examples/pascal_triangle.prose --run
node bin/prose.js examples/copy_workshop.prose --run
node bin/prose.js examples/reading_list.prose --run
node bin/prose.js examples/habits.prose --run
node bin/prose.js examples/tour.prose --run
```

Each program is standalone. Quoted strings on their own lines explain the code.

| Program | What it demonstrates |
| --- | --- |
| [camp_budget.prose](camp_budget.prose) | Nested objects, object returns, arrays of objects, array appending, decimal arithmetic, inferred call boundaries, `for`, conditionals, booleans, and `null` |
| [postcard_station.prose](postcard_station.prose) | Unicode strings, `length`, character conversions, mathematical `mod`, negative rotations, string replacement/appending, unset declarations, `while`, zero-argument calls, early returns, and escapes |
| [pascal_triangle.prose](pascal_triangle.prose) | Recursion, returning arrays, empty and one-item arrays, nested arrays, calculated indexes, and copied array arguments |
| [copy_workshop.prose](copy_workshop.prose) | Shared arrays and objects, copying with `slice`, changes made through function arguments, empty objects, missing properties, division, `%`, and prefix `remainder` |
| [reading_list.prose](reading_list.prose) | `for each` with several variables, inline `if`, functions as values with inline and indented bodies, JavaScript methods with `with` and `run`, `new Map`, `Math`, and `otherwise` |
| [habits.prose](habits.prose) and [habit_rules.prose](habit_rules.prose) | The newest features: one Prose file importing another and calling its functions without `with`, optional arguments, `maybe` on properties and methods, Map entries in `for each`, and the parentheses that unambiguous `with` calls need |
| [tour.prose](tour.prose) and [tour_helpers.prose](tour_helpers.prose) | Every construct Prose supports, section by section, including imports from Prose and from Node.js (`node:path`) and exports |

`tour.prose` exercises every implemented construct: assignments; bare and
empty-`is` unset declarations; numbers, strings with escapes, booleans, null,
and `unset`; arithmetic, comparison, logical, and `otherwise` operators;
parentheses; ordinary and zero-argument functions; expression returns and bare
returns; recursion; `if`/`else if`/`else`; inline conditionals and inline `if`
values; `for`, `for each`, and `while`; property-only object bodies; `:`
property access; one-based `.` indexing; comma arrays; string and array writes;
functions as values; JavaScript globals, methods, and `new`; `maybe`; `use`
and `export`; and the three standard-library string functions.

## Things to notice

- The camp bill totals **55**, leaving **5** from its budget. Changing the budget
  lets you explore the conditional branches.
- The postcard program shifts `hello, zoo! 😀` to `khoor, crr! 😀` and back.
  It preserves non-lowercase characters in this example's function.
- Pascal's triangle contains six rows. The third entry of its sixth row is **10**.
- The copy workshop prints an original price of **10** and a sale price of **8**,
  because it marks down a `slice` copy. The uncopied clearance markdown then
  changes the original to **5**, and nested rows and objects show every change
  through each name that shares them.
- The reading list finishes two of its three books and averages **492** pages.
- The habit log's longest streak is Read, **5** days in a row; Swim has no
  check-ins, so `maybe` reports "none yet" instead of failing.
- Use `(rows.6).3` or `rows.(6).3` for chained numeric indexes:
  `rows.6.3` would contain the decimal number `6.3`.
- `-1 % 26` and `remainder -1 26` give **-1**; `-1 mod 26` gives **25**.

The earlier factorial, Fibonacci, FizzBuzz, array, object, and cipher examples
are also available. `MusicTicker.prose` remains a design sketch requiring
features that are not implemented yet (async, `try`/`catch`, and nested named functions).
