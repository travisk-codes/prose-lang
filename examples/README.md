# Prose examples

Run these from the repository root with Node.js; no package installation is
needed to run the compiler.

```powershell
node bin/prose.js examples/camp_budget.prose --run
node bin/prose.js examples/postcard_station.prose --run
node bin/prose.js examples/pascal_triangle.prose --run
node bin/prose.js examples/copy_workshop.prose --run
```

Each program is standalone. Quoted strings on their own lines explain the code.

| Program | What it demonstrates |
| --- | --- |
| [camp_budget.prose](camp_budget.prose) | Nested objects, object returns, arrays of objects, array appending, decimal arithmetic, inferred call boundaries, `for`, conditionals, booleans, and `null` |
| [postcard_station.prose](postcard_station.prose) | Unicode strings, `length`, character conversions, mathematical `mod`, negative rotations, string replacement/appending, unset declarations, `while`, zero-argument calls, early returns, and escapes |
| [pascal_triangle.prose](pascal_triangle.prose) | Recursion, returning arrays, empty and one-item arrays, nested arrays, calculated indexes, and copied array arguments |
| [copy_workshop.prose](copy_workshop.prose) | Array argument copies, recursive array copies, shared objects inside arrays, property mutation through functions, empty objects, missing properties, division, `%`, and prefix `remainder` |

Together these exercise all currently implemented language constructs:
assignments; bare and empty-`is` unset declarations; numbers, strings, booleans,
and null; arithmetic, comparison, and logical operators; parentheses; ordinary
and zero-argument functions; expression returns and bare returns; recursion;
`if`/`else if`/`else`; inline conditionals; `for` and `while`; property-only
object bodies; `:` property access; one-based `.` indexing; comma arrays;
string and array writes; and the three standard-library string functions.

## Things to notice

- The camp bill totals **55**, leaving **5** from its budget. Changing the budget
  lets you explore the conditional branches.
- The postcard program shifts `hello, zoo! 😀` to `khoor, crr! 😀` and back.
  It preserves non-lowercase characters in this example's function.
- Pascal's triangle contains six rows. The third entry of its sixth row is **10**.
- The copy workshop prints an original price of **10** and a sale price of **8**.
  Nested array changes stay isolated, while publishing an object through a
  copied array changes the original object too.
- Use `(rows.6).3` or `rows.(6).3` for chained numeric indexes:
  `rows.6.3` would contain the decimal number `6.3`.
- `-1 % 26` and `remainder -1 26` give **-1**; `-1 mod 26` gives **25**.

The earlier factorial, Fibonacci, FizzBuzz, array, object, and cipher examples
are also available. `MusicTicker.prose` remains a design sketch requiring
features that are not implemented yet.
