# Wrapping lines and reading layout errors

Use the formatter for a preferred layout. It keeps fitting line breaks and
reflows long statements without changing their parsed meaning. These patterns
cover the common cases.

## Expressions and parentheses

An operator or comma at the end of a line leaves the expression open. Indent
the next line farther than the statement's first line:

```text
total is 1 +
    2
```

An open parenthesis also continues the statement. Every following line,
including a separate closing parenthesis, remains indented farther:

```text
total is (
    1 + 2
    )
```

Extra indentation after a completed expression does not continue it. An error
identifies that completed line and illustrates an explicit continuation.

## Conditions and conditional values

Leading `and` and `or` can continue `if`, `else if`, and `while` conditions.
Finish the condition before starting its body:

```text
if true
or false
    print "chosen"
```

For a conditional value, put `if` and `else` farther right than the value's
statement. Align those clauses with each other:

```text
label is "yes"
    if true
    else "no"
```

An `if` aligned with a preceding `return` remains a block statement. For an
ordinary assignment or returned value, continue a logical expression by putting
`and` or `or` at the end of the preceding line.

## Function headers

Keep a wrapped `takes` list open with commas. A `giving` clause can align with
the function header:

```text
function combine takes
    first as number,
    second as number,
giving number
    return first + second
```

Without `giving`, omit the last parameter's comma. That ends the header so the
next indented line can start its body. A typed local declaration in the body
uses `name as type is value`; it is separate from a parameter declaration.

Object and type fields at the same level also align. To nest object properties,
introduce another `object` value before its indented fields.

## Diagnostic guidance

Common layout errors now explain why a line did not continue its statement and
show a supported example. Examples illustrate syntax; choose the operator,
names, and block structure that express your intended meaning.

CLI compilation, checking, formatting, and the browser playground share these
messages. Invalid formatting requests leave the source untouched. In VS Code,
expand a Problem's related information to jump to the originating statement,
header, opening parenthesis, or a misplaced continuation line.

For programmatic checking, a layout diagnostic can include `relatedInformation`
entries with original `file`, `line`, `column`, and `message` fields. Lines and
UTF-16 columns are one-based. The diagnostic's main `message` includes its example.
Compiler `SyntaxError` objects also expose optional `column`, `layout`, and
`relatedInformation` metadata. This guidance is added after parsing fails;
successful parsing, generated JavaScript, and accepted wrapping rules stay the same.
