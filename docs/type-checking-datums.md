# Datums checking-output measurement

Measured 2026-10-29 against the local prose-pilot checkout at D:/Datums/datums.
Application files and generated declarations were not modified.

- 46 Prose modules, using the project's TypeScript 6.0.3.
- 28 remaining diagnostics, all mapped back to Prose locations.
- 167 implicit-any/unknown diagnostics excluded under the draft's untyped policy.
- The handoff initially reported 34; allowing fields on returned unannotated
  objects removed two false positives, with further untyped-placeholder fixes
  reflected in this final count.

| Group | Diagnostics | Interpretation |
| --- | ---: | --- |
| Literal/union widening | 11 | Inferred text is broader than a declared literal union; return/local annotations or stronger narrowing are needed. |
| Nullable values and narrowing | 11 | Optional results or projected nullable fields need a guard, fallback, or a type predicate the checker can see. |
| Readonly/mutable contracts | 5 | A readonly parameter is returned as a mutable list, or a ReadonlyMap is stored in a mutable Map slot. |
| Generic annotation mismatch | 1 | sort_events_by_time declares a free type variable event but passes it to a CalendarEvent comparator. |

These are diagnostics, not a count of runtime bugs. The narrowing and widening
groups include valid runtime idioms that need better annotation/inference
handling before checking can become a build gate.

## Concrete annotation issue

In src/lib/calendar.prose, lines 77-78 use list of event. A lowercase event
introduces a generic type parameter; it does not refer to CalendarEvent.
The comparator used on line 80 requires CalendarEvent. Use list of
CalendarEvent for both the parameter and result if this is a calendar-only
sort, or redesign the comparator contract for a genuinely generic sort.
No Datums changes were made in this stage.

## Remaining locations

Paths below are relative to Datums. Messages show their first clause; the
JSON output of the measurement script contains the complete diagnostic.

| Location | Code | Message |
| --- | --- | --- |
| `src/lib/analysis/compare.prose:196` | TS2322 | Type '{ kind: string; reason: string; side: any; days: any; total: any; }' is not assignable to type 'Comparison'. |
| `src/lib/analysis/compare.prose:197` | TS2322 | Type 'string' is not assignable to type '"a" &#124; "b"'. |
| `src/lib/analysis/compare.prose:204` | TS2322 | Type '{ kind: string; reason: string; side: any; days: any; total: any; }' is not assignable to type 'Comparison'. |
| `src/lib/analysis/series.prose:164` | TS2345 | Argument of type '{ month: string; year: any; }' is not assignable to parameter of type 'DateTimeFormatOptions'. |
| `src/lib/analysis/series.prose:339` | TS2532 | Object is possibly 'undefined'. |
| `src/lib/analysis/trend.prose:69` | TS2322 | Type '{ label: string; value: number &#124; null; }' is not assignable to type 'MonthFigure'. |
| `src/lib/analysis/trend.prose:70` | TS18047 | '_prose_month.value' is possibly 'null'. |
| `src/lib/analysis/trend.prose:70` | TS18047 | '_prose_best.value' is possibly 'null'. |
| `src/lib/calendar.prose:80` | TS2345 | Argument of type 'event' is not assignable to parameter of type 'CalendarEvent'. |
| `src/lib/calendar.prose:137` | TS2322 | Type 'number' is not assignable to type '0 &#124; 3 &#124; 1 &#124; 2 &#124; 4'. |
| `src/lib/period.prose:134` | TS2345 | Argument of type 'string' is not assignable to parameter of type 'Flow'. |
| `src/lib/period.prose:135` | TS2345 | Argument of type 'string &#124; null' is not assignable to parameter of type 'Flow &#124; null'. |
| `src/lib/periodLog.prose:120` | TS2345 | Argument of type 'string &#124; undefined' is not assignable to parameter of type 'string'. |
| `src/lib/savedFilters.prose:46` | TS4104 | The type 'readonly string[]' is 'readonly' and cannot be assigned to the mutable type 'string[]'. |
| `src/lib/tagColor.prose:15` | TS2739 | Type 'ReadonlyMap<string, string>' is missing the following properties from type 'Map<any, any>': clear, delete, set, [Symbol.toStringTag] |
| `src/lib/tagEdits.prose:205` | TS2345 | Argument of type 'string &#124; undefined' is not assignable to parameter of type 'string'. |
| `src/lib/tagEdits.prose:211` | TS2322 | Type '(Datum &#124; undefined)[]' is not assignable to type 'Datum[]'. |
| `src/lib/tags.prose:105` | TS4104 | The type 'readonly DatumTag[]' is 'readonly' and cannot be assigned to the mutable type 'DatumTag[]'. |
| `src/lib/tags.prose:137` | TS4104 | The type 'readonly DatumTag[]' is 'readonly' and cannot be assigned to the mutable type 'DatumTag[]'. |
| `src/lib/tags.prose:169` | TS2532 | Object is possibly 'undefined'. |
| `src/lib/tags.prose:169` | TS2532 | Object is possibly 'undefined'. |
| `src/lib/todos.prose:95` | TS2322 | Type 'string' is not assignable to type 'TodoRepeatUnit'. |
| `src/lib/todos.prose:100` | TS2322 | Type 'string' is not assignable to type 'TodoRepeatUnit'. |
| `src/lib/todos.prose:111` | TS2532 | Object is possibly 'undefined'. |
| `src/lib/todos.prose:118` | TS18048 | '_prose_word' is possibly 'undefined'. |
| `src/lib/viewOrder.prose:47` | TS2322 | Type 'string[]' is not assignable to type 'View[]'. |
| `src/lib/viewPaths.prose:49` | TS2322 | Type 'string' is not assignable to type 'View'. |
| `src/lib/viewVisibility.prose:31` | TS4104 | The type 'readonly View[]' is 'readonly' and cannot be assigned to the mutable type 'View[]'. |

Reproduce from the Prose checkout with:

```powershell
node scripts/measure-check.mjs D:/Datums/datums --json
node bin/prose.js check --project D:/Datums/datums --json
```

The public command reproduces the same 28 diagnostics across 46 modules. The
measurement script now uses that checker while keeping the audit's JSON format.
