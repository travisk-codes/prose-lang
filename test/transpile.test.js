import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transpile } from "../src/transpile.js";
import { run } from "./run.js";

test("the original FizzBuzz example prints all 100 expected lines", () => {
  const source = readFileSync(new URL("../examples/fizzbuzz.prose", import.meta.url), "utf8");
  const expected = Array.from({ length: 100 }, (_, index) => {
    const n = index + 1;
    return n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Fizz" : n % 5 === 0 ? "Buzz" : n;
  });
  assert.deepEqual(run(source), expected);
});

test("arithmetic, comparison, and boolean precedence", () => {
  assert.deepEqual(run([
    "print 2 + 3 * 4",
    "print (2 + 3) * 4",
    "print 10 - 3 - 2",
    "print 2 + 3 = 5",
    "print not 2 + 3 = 5",
    "print true or false and false",
    "print remainder (10 + 2) 5"
  ].join("\n")), [14, 20, 5, true, false, true, 2]);
});

test("strings preserve escapes and cannot inject JavaScript", () => {
  const text = 'quote: " slash: \\ newline: \n"; throw new Error("injected"); //';
  assert.deepEqual(run(`print ${JSON.stringify(text)}`), [text]);
  assert.deepEqual(run('print "is"\nprint "not"\nprint "true"'), ["is", "not", "true"]);
});

test("assignments persist across branches and loops, including JS keyword names", () => {
  assert.deepEqual(run([
    "class is 0", "for n is 1 to 3", "    class is class + n",
    "if class = 6", "    answer is 42", "else", "    answer is 0",
    "print class", "print answer"
  ].join("\n")), [6, 42]);
});

test("nested blocks dedent correctly and loops include both bounds", () => {
  assert.deepEqual(run([
    "for i is 1 to 2", "    for j is 1 to 2", "        print i * 10 + j",
    "    print i", "print 99", "for n is 3 to 1", "    print n"
  ].join("\n")), [11, 12, 1, 21, 22, 2, 99]);
});

test("blank lines, CRLF, BOM, tabs, and unary negatives", () => {
  assert.deepEqual(run('\uFEFFx is -2\r\n\r\nif x < 0\r\n\tprint -x\r\nprint 7'), [2, 7]);
});

test("loop upper bound is evaluated once", () => {
  assert.deepEqual(run("limit is 3\nfor i is 1 to limit\n    print i\n    limit is 0"), [1, 2, 3]);
});

test("logical expressions short circuit", () => {
  assert.deepEqual(run([
    "function noisy", '    print "evaluated"', "    return true",
    "print false and noisy run", "print true or noisy run"
  ].join("\n")), [false, true]);
});

test("invalid or unsupported syntax reports the original source line", () => {
  for (const [source, expected] of [
    ["\nprint", /Line 2: Expected an expression/],
    ['print "oops', /Line 1: Unterminated string/],
    ["if true\nprint 1", /Line 1: Expected an indented body/],
    ["print 1\n  print 2", /Line 2: Unexpected indentation/],
    ["if true\n    print 1\n  print 2", /Line 3: Unexpected indentation/],
    ["else\n  print 1", /Line 1:/],
    ["print 1 2", /Line 1: Unexpected token/],
    ["print (1 + 2", /Line 1: Expected '\)'/],
    ["async function f\n  print 1", /Line 1:.*not supported/],
    ["if true\n  print 1\nelse if\n  print 2", /Line 3:/]
  ]) assert.throws(() => transpile(source), expected);
});

test("CLI emits JavaScript and runs the unchanged example", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const example = fileURLToPath(new URL("../examples/fizzbuzz.prose", import.meta.url));
  const compiled = spawnSync(process.execPath, [cli, example], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.match(compiled.stdout, /console\.log/);
  const executed = spawnSync(process.execPath, [cli, example, "--run"], { encoding: "utf8" });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout.trim().split(/\r?\n/).length, 100);
  const invalid = spawnSync(process.execPath, [cli, example, "--invalid"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
});

test("Fibonacci uses explicit compound arguments and isolated recursive locals", () => {
  const source = readFileSync(new URL("../examples/fibonacci.prose", import.meta.url), "utf8");
  assert.deepEqual(run(source + "\nfor n is 0 to 10\n    print fibonacci n"),
    [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
});

test("calls bind before following arithmetic unless arguments are parenthesized", () => {
  assert.deepEqual(run([
    "function double takes number", "    return number * 2",
    "print double 5 - 1", "print double (5 - 1)",
    "print double 2 + 3 * 4", "print double (2 + 3 * 4)",
    "print 2 * double 3 + 1", "print (double 3) + 1",
    "print double double 2 + 1"
  ].join("\n")), [9, 8, 16, 28, 13, 7, 9]);
});

test("multiple arguments, nested calls, and forward declarations", () => {
  assert.deepEqual(run([
    "print add (double 3), (double 4)",
    "function add takes left, right", "    return left + right",
    "function double takes value", "    return value * 2",
    "print (add 2, 3) * 4", "print add 2, (3 * 4)"
  ].join("\n")), [14, 20, 14]);
});

test("arithmetic right after several arguments is ambiguous, but not after one", () => {
  assert.throws(() => transpile("function add takes left, right\n    return left + right\nprint add 2, 3 * 4"), /'\*' right after a call's arguments is ambiguous/);
  assert.deepEqual(run("function double takes value\n    return value * 2\nprint double 3 + 1"), [7]);
});

test("mutual recursion and inline conditionals", () => {
  assert.deepEqual(run([
    "function even takes n", "    if n = 0 return true", "    return odd (n - 1)",
    "function odd takes n", "    if n = 0 return false", "    return even (n - 1)",
    "print even 10", "print odd 10",
    "if false print 0", "else if true print 1", "else print 2"
  ].join("\n")), [true, false, 1]);
});

test("function locals and reassigned parameters do not overwrite outer bindings", () => {
  assert.deepEqual(run([
    "n is 99", "total is 100",
    "function sum takes n", "    total is 0", "    for i is 1 to n",
    "        total is total + i", "    n is 0", "    return total",
    "print sum 4", "print sum 2", "print n", "print total"
  ].join("\n")), [10, 3, 99, 100]);
});

test("zero-argument calls and early or implicit returns", () => {
  assert.deepEqual(run([
    "function hello", '    print "hello"', "hello run",
    "function halt", "    return", '    print "unreachable"', "print halt run",
    "function implicit", "    x is 1", "print implicit run",
    "function search takes limit", "    for n is 1 to limit",
    "        if n = 3 return n", "    return 0", "print search 5"
  ].join("\n")), ["hello", undefined, undefined, 3]);
});

test("function declaration, scope, and arity errors report source lines", () => {
  for (const [source, expected] of [
    ["return 1", /Line 1:.*only allowed inside a function/],
    ["if true return 1", /Line 1:.*only allowed inside a function/],
    ["function f takes x, x\n    return x", /Line 1: Duplicate parameter/],
    ["function f takes\n    return 1", /Line 1:/],
    ["function f\n    return 1\nfunction f\n    return 2", /Line 3: Duplicate function/],
    ["function f\n    function g\n        return 1", /Line 2:.*top level/],
    ["function f takes x, y\n    return x\nprint f 1", /Line 3: Expected ','/],
    ["function f\n    return 1\nf is 2", /Line 3:.*conflicts/],
    ["function f takes f\n    return 1", /Line 1:.*conflicts/],
    ["function f\n    return 1\nfor f is 1 to 2\n    print f", /Line 3:.*conflicts/]
  ]) assert.throws(() => transpile(source), expected);
});

test("CLI runs the Fibonacci demo", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const demo = fileURLToPath(new URL("../examples/fibonacci_demo.prose", import.meta.url));
  const result = spawnSync(process.execPath, [cli, demo, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).map(Number), [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
});

test("both corrected factorial functions agree for zero through ten", () => {
  const source = readFileSync(new URL("../examples/factorial.prose", import.meta.url), "utf8");
  const expected = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
  assert.deepEqual(run(source + "\nfor n is 0 to 10\n    print factorial1 n\n    print factorial2 n"),
    expected.flatMap(value => [value, value]));
});

test("while checks the condition before entry and reevaluates it after each iteration", () => {
  assert.deepEqual(run([
    "n is 0", "while n < 3", "    print n", "    n is n + 1",
    "while false", '    print "unreachable"', "print n"
  ].join("\n")), [0, 1, 2, 3]);
});

test("while conditions support function calls and short circuiting", () => {
  assert.deepEqual(run([
    "function below takes n", "    return n < 3",
    "n is 0", "while below n", "    n is n + 1", "print n",
    "missing", "while false and missing", '    print "unreachable"'
  ].join("\n")), [3]);
});

test("nested while and for blocks dedent and update their enclosing scope", () => {
  assert.deepEqual(run([
    "total is 0", "for i is 1 to 2", "    j is 0", "    while j < i",
    "        k is 0", "        while k < 2",
    "            total is total + 1", "            k is k + 1",
    "        j is j + 1", "    print total", "print total"
  ].join("\n")), [2, 6, 6]);
});

test("return exits a while loop and function locals stay isolated", () => {
  assert.deepEqual(run([
    "n is 99", "function find takes limit", "    n is 0",
    "    while n < limit", "        n is n + 1",
    "        if n = 3 return n", "    return 0",
    "print find 5", "print find 2", "print n"
  ].join("\n")), [3, 0, 99]);
});

test("malformed while headers and bodies report line numbers", () => {
  for (const [source, expected] of [
    ["while\n    print 1", /Line 1: Expected an expression/],
    ["while true", /Line 1: Expected an indented body/],
    ["while true\nprint 1", /Line 1: Expected an indented body/],
    ["while true print 1", /Line 1: Unexpected token/],
    ["while true\n    print 1\n  print 2", /Line 3: Unexpected indentation/],
    ["while false\n    return 1", /Line 2:.*only allowed inside a function/]
  ]) assert.throws(() => transpile(source), expected);
});

test("CLI runs the factorial demo", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const demo = fileURLToPath(new URL("../examples/factorial_demo.prose", import.meta.url));
  const result = spawnSync(process.execPath, [cli, demo, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const expected = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).map(Number),
    expected.flatMap(value => [value, value]));
});

test("the corrected Caesar cipher wraps lowercase letters for positive and negative rotations", () => {
  const source = readFileSync(new URL("../examples/caesar_cipher.prose", import.meta.url), "utf8");
  assert.deepEqual(run(source + [
    "", 'print cipher "xyz", 3', 'print cipher "abc", -3',
    'print cipher "hello", 13', 'print cipher "hello", 26',
    'print cipher "abc", 53', 'print cipher "", 3'
  ].join("\n")), ["abc", "xyz", "uryyb", "hello", "bcd", ""]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (const shift of [-53, -27, -26, -1, 0, 1, 13, 25, 26, 27, 53]) {
    assert.deepEqual(run(source + `\nencoded is cipher "${alphabet}", ${shift}\nprint cipher encoded, ${-shift}`), [alphabet]);
  }
});

test("string length, indexing, and character conversions use Unicode code points", () => {
  assert.deepEqual(run([
    'word is "a😀z"', "i is 2", "print length word", "print word.i",
    "print char_to_number word.i", "print number_to_char 128512",
    'print length "e\\u0301"', 'print char_to_number "a"',
    "print number_to_char 97", 'print length ("a" + "😀")',
    'print "cat".1'
  ].join("\n")), [3, "😀", 128512, "😀", 2, 97, "a", 2, "c"]);
});

test("indexing binds before calls and arithmetic; parentheses group compound indexes", () => {
  assert.deepEqual(run([
    'word is "cat"', "i is 2",
    "print char_to_number word.i + 1", "print word.(i + 1)",
    "print (number_to_char 128512).1",
    "function twice takes value", "    return value * 2",
    "print twice (char_to_number word.i) - 1"
  ].join("\n")), [98, "t", "😀", 193]);
});

test("single-character indexed writes replace or append without changing other string values", () => {
  assert.deepEqual(run([
    'word is "a😀c"', "copy is word", 'word.2 is "z"', 'word.4 is "😀"',
    "print word", "print copy", "print length word",
    "function replace takes text", '    text.1 is "x"', "    return text",
    "print replace word", "print word"
  ].join("\n")), ["azc😀", "a😀c", 4, "xzc😀", "azc😀"]);
});

test("bare and empty-is declarations start unset and become strings on indexed assignment", () => {
  assert.deepEqual(run([
    "first", "second is", 'third is ""', "print first", "print second", "print third",
    'first.1 is "😀"', 'first.2 is "a"', 'second.1 is "b"',
    "print first", "print second",
    "function create", "    result", '    result.1 is "x"', "    return result",
    "print create run"
  ].join("\n")), [undefined, undefined, "", "😀a", "b", "x"]);
});

test("missing reads return unset, while skipped and invalid writes fail with source lines", () => {
  assert.deepEqual(run([
    'word is "cat"', "print word.0", "print word.4", "print word.(-1)",
    "print word.1.5", "print unset.1"
  ].join("\n")), [undefined, undefined, undefined, undefined, undefined]);
  for (const statement of [
    'word.0 is "s"', 'word.5 is "s"', 'word.(-1) is "s"', 'word.(1.5) is "s"'
  ]) assert.throws(() => run('word is "cat"\n' + statement), /Line 2:.*gaps are not allowed/);
});

test("standalone string expressions are discarded as comments without becoming directives", () => {
  assert.deepEqual(run([
    '"a comment"', '"use asm"', '""', 'print "hello"',
    "function identity takes value", '    "inside a function"', "    return value",
    "print identity 42"
  ].join("\n")), ["hello", 42]);
});

test("mathematical mod wraps negative rotations without changing remainder behavior", () => {
  assert.deepEqual(run([
    "print -1 mod 26", "print 53 mod 26", "print -26 mod 26",
    "print 1 mod 10000000000000000", "print (2 + 3) mod 3 * 2",
    "print -1 % 26", "print remainder -1 26"
  ].join("\n")), [25, 1, 0, 1, 4, -1, -1]);
  assert.throws(() => run("print 1 mod 0"), /Line 1:.*nonzero divisor/);
});

test("string helpers reject invalid types and unsupported multi-character writes", () => {
  for (const [source, expected] of [
    ["print length 2", /Line 1: Expected a string/],
    ['print char_to_number ""', /Line 1:.*exactly one Unicode/],
    ['print char_to_number "ab"', /Line 1:.*exactly one Unicode/],
    ["print number_to_char -1", /Line 1:.*integer from/],
    ["print number_to_char 1114112", /Line 1:.*integer from/],
    ["print number_to_char 1.5", /Line 1:.*integer from/],
    ['word is "a"\nword.1 is "ab"', /Line 2:.*exactly one Unicode/],
    ['word is 1\nprint word.1', /Line 2: Expected a string/]
  ]) assert.throws(() => run(source), expected);
});

test("malformed indexing and standard-library conflicts report source lines", () => {
  for (const [source, expected] of [
    ['word is "a"\nprint word.', /Line 2: Expected an index/],
    ['word is "a"\nword.1 is', /Line 2: Indexed assignment requires a value/],
    ["length is 1", /Line 1:.*conflicts/],
    ["function length takes value\n    return value", /Line 1: Duplicate function/],
    ["print length", /Line 1: Expected an expression/],
    ["print 2 mod", /Line 1: Expected an expression/]
  ]) assert.throws(() => transpile(source), expected);
});

test("CLI runs the Caesar cipher demo as standalone generated JavaScript", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const demo = fileURLToPath(new URL("../examples/caesar_cipher_demo.prose", import.meta.url));
  const result = spawnSync(process.execPath, [cli, demo, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["khoor", "hello", "abc", "xyz"]);
});

test("indented objects have nested properties, expression values, and correct dedentation", () => {
  assert.deepEqual(run([
    "year is 2000", "function double takes value", "    return value * 2",
    "person is object", '    name is "Ada"', "    age is double 18",
    "    address is object", '        city is "London"',
    "    born is year - 36", "print person:name", "print person:age",
    "print person:address:city", "print person:born", "print year"
  ].join("\n")), ["Ada", 36, "London", 1964, 2000]);
});

test("empty objects and unset fields can be populated after creation", () => {
  assert.deepEqual(run([
    "person is object", 'person:name is "Ada"', "person:age is 36",
    "person:address is object", '    city is "London"',
    "person:address:city is \"Paris\"", "person:optional is",
    "print person:name", "print person:age", "print person:address:city",
    "print person:optional", "print person:missing"
  ].join("\n")), ["Ada", 36, "Paris", undefined, undefined]);
});

test("property names are literal and do not conflict with keywords, variables, or built-ins", () => {
  assert.deepEqual(run([
    'name is "other"', "person is object",
    '    name is "Ada"', "    length is 4", "    if is true", "    is is 5",
    "function identity takes value", "    return value",
    "print person:name", "print person:length", "print person:if",
    "print identity person:is", "person:is is 6", "print person:is", "print name"
  ].join("\n")), ["Ada", 4, true, 5, 6, "other"]);
});

test("property and string indexing bind before calls and following arithmetic", () => {
  assert.deepEqual(run([
    "person is object", '    name is "Ada"', "    age is 36", "i is 2",
    "print length person:name", "print person:name.i", "print person:age + 1",
    "print char_to_number person:name.1"
  ].join("\n")), [3, "d", 37, 65]);
});

test("objects use references while property mutation inside functions preserves binding scope", () => {
  assert.deepEqual(run([
    "person is object", '    name is "Ada"', "alias is person",
    "function rename takes target", '    target:name is "Grace"',
    "rename person", "print alias:name",
    "function update_global", "    person:age is 36", "update_global run",
    "print person:age"
  ].join("\n")), ["Grace", 36]);
});

test("objects can be returned and each literal creates a fresh value", () => {
  assert.deepEqual(run([
    "function create takes age", "    return object", "        years is age",
    "a is create 1", "b is create 2", "a:years is 99",
    "print a:years", "print b:years"
  ].join("\n")), [99, 2]);
});

test("quoted comments in object bodies do not create fields or leak property names into scope", () => {
  assert.deepEqual(run([
    'city is "outside"', "person is object", '    "comment"',
    '    city is "inside"', "print person:city", "print city"
  ].join("\n")), ["inside", "outside"]);
});

test("indexed writes through object properties preserve Unicode and append rules", () => {
  assert.deepEqual(run([
    "person is object", '    name is "a😀z"', 'person:name.2 is "b"',
    'person:name.4 is "!"', "print person:name",
    "person:empty is", 'person:empty.1 is "😀"', "print person:empty"
  ].join("\n")), ["abz!", "😀"]);
});

test("assignment targets and computed indexes are evaluated once and before the right side", () => {
  assert.deepEqual(run([
    "state is object", '    text is "abc"', "    count is 0",
    "function choose", '    state:text is "zzz"', "    state:count is state:count + 1",
    "    return 1", "function replacement",
    "    state:count is state:count + 1", '    return "x"',
    "state:text.(choose run) is replacement run",
    "print state:text", "print state:count"
  ].join("\n")), ["xbc", 2]);
});

test("special property names stay ordinary data instead of changing prototypes", () => {
  assert.deepEqual(run([
    "person is object", '    __proto__ is "data"',
    '    constructor is "builder"', "print person:__proto__",
    'person:__proto__ is "changed"', "print person:__proto__",
    "other is object", "print other:missing", "print person:constructor"
  ].join("\n")), ["data", "changed", undefined, "builder"]);
});

test("object bodies reject ordinary statements and malformed property access reports lines", () => {
  for (const [source, expected] of [
    ['person is object\n    print "no"', /Line 2:.*only property definitions/],
    ["person is object\n    if true\n        x is 1", /Line 2:.*only property definitions/],
    ["person is object\n    for n is 1 to 2\n        x is n", /Line 2:.*only property definitions/],
    ["person is object\n    function f\n        return 1", /Line 2:.*only property definitions/],
    ["person is object\n    x is 1\n  y is 2", /Line 3: Unexpected indentation/],
    ["person is object\nprint person:", /Line 2: Expected a property name/],
    ["person is object\nperson:1 is 2", /Line 2: Expected a property name/]
  ]) assert.throws(() => transpile(source), expected);
  assert.throws(() => run("person is null\nprint person:name"), /Line 2: Can't read property 'name' of null/);
  assert.throws(() => run("person is unset\nprint person:name"), /Line 2: Can't read property 'name' of unset/);
  assert.throws(() => run("person is 1\nperson:name is 2"), /Line 2:.*requires an object/);
});

test("CLI runs the object example", () => {
  const cli = fileURLToPath(new URL("../bin/prose.js", import.meta.url));
  const example = fileURLToPath(new URL("../examples/objects.prose", import.meta.url));
  const result = spawnSync(process.execPath, [cli, example, "--run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["Ada", "36", "London", "Paris"]);
});
