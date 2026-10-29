# Prose and JavaScript conventions

Prose positions start at 1 and count Unicode code points in text. JavaScript
properties and methods keep JavaScript's behavior. The spelling at the call site
determines which rules apply.

| Operation | Convention |
| --- | --- |
| `words.1`, `words.i`, `word.(i + 1)` | Prose positions start at 1; text positions count code points |
| `length word` | Number of Unicode code points; list arguments count elements |
| `word:length` or `word.length` | JavaScript text length counts UTF-16 code units |
| `words:at 0` | JavaScript positions start at 0; negative positions count from the end |
| `words:slice with 0, 2` | Start at JavaScript position 0; stop before position 2 |
| `words:index_of value` | JavaScript position, starting at 0; `-1` means missing |
| `record:user_id` | The JavaScript property `userId` |
| `record.("user_id")` | The literal JavaScript property `user_id` |

The dotted method forms, such as `words.slice`, use the same JavaScript behavior
when they resolve to properties. A numeric variable named `slice` can make that
dot select a Prose position instead. A colon always selects the property.

## Text: code points and UTF-16

```text
word is "😀"
print length word
print word:length
print word.1
print word:slice with 0, 2
```

This prints `1`, `2`, `😀`, and `😀`. JavaScript stores this emoji using two
UTF-16 code units. Its `slice`, `at`, `indexOf`, `substring`, and character-code
methods use UTF-16 positions; slicing at position 1 can split the emoji.

Prose code points are not visual character clusters: combining marks and emoji
joined from several code points can occupy several Prose positions. The existing
code-point and JavaScript rules also apply to `maybe` access when a value exists.

## Lists: translating positions

```text
words is "first", "second", "third"
print words.1
print words:at 0
print words:slice with 0, 2

js_position is words:index_of "second"
if js_position >= 0
    print words.(js_position + 1)
```

The first two statements both print `first`. The slice contains `first` and
`second`. `index_of` returns `1` for `second`, so adding 1 converts that result
to a Prose list position. Check for `-1` before converting a missing result.

That `+ 1` conversion works for list positions. A JavaScript text offset counts
UTF-16 units, so adding 1 does not convert it to a Prose code-point position
after characters such as 😀.

## Properties: contextual dots, explicit colons, and exact keys

```text
words is "first", "second"
map is 1
print words.map
print words:map function takes word return word:to_upper_case run
```

`words.map` selects the first item using the numeric variable. `words:map`
selects the JavaScript method and prints the uppercase list. On objects, a bare
dot name remains a literal property name, even when a variable has that name.

Bare property names use Prose's snake_case-to-camelCase spelling for both
accessors: `record.user_id` and `record:user_id` select `userId`. A colon forces
property access; it does not disable name conversion. Computed string keys
preserve the string exactly: `record.("user_id")` and `record:("user_id")`
select `user_id`. They also work for reading external JSON with underscores.
Computed numeric dot keys select Prose positions on text and lists, and ordinary
JavaScript property keys on other receivers. Computed numeric colon keys always
use ordinary JavaScript property keys.

## VS Code reminders

Hover over `length`, a text's `length` property, native position methods such as
`slice`, `at`, and `index_of`, a Prose position, or a converted property name.
The hover explains the applicable convention alongside the existing type and
documentation. Hover over a quoted computed key to see the exact-key reminder.
Hints for native methods require a known text/list receiver and a standard
library signature; custom methods and unknown receivers receive no native-method
claim. These hovers use the project's TypeScript and require Workspace Trust.

Run [interop_boundaries.prose](../examples/interop_boundaries.prose) to try the
conventions together.
