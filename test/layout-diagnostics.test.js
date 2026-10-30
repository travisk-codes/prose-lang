import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, parse } from '../src/transpile.js';
import { format } from '../src/format.js';

function failure(source) {
  try { compile(source); assert.fail('Expected a syntax error'); }
  catch (error) { assert.equal(error.name, 'SyntaxError'); return error; }
}

test('indentation errors explain completed statements and preserve the failing line', () => {
  const source = 'total is 1\n    + 2';
  const error = failure(source);
  assert.match(error.message, /^Line 2: Unexpected indentation\. Line 1 is already a complete statement/);
  assert.match(error.message, /extra indentation alone does not continue it/);
  assert.equal(error.column, 5);
  assert.equal(error.layout.kind, 'indent');
  assert.equal(error.relatedInformation[0].line, 1);
  assert.doesNotThrow(() => compile(error.layout.example));
  assert.throws(() => format(source), error => /Example layout:/.test(error.message));
});

test('missing block bodies and unfinished expression lines identify their starting statement', () => {
  for (const [source, kind, start] of [
    ['if true\nor false\nprint 1', 'body', 1],
    ['function greet', 'body', 1],
    ['total is 1 +\n2', 'continuation-indent', 1],
    ['function size takes value giving\nnumber\n    return 1', 'continuation-indent', 1],
    ['print (\n    1 + 2\n)', 'parentheses', 1]
  ]) {
    const error = failure(source);
    assert.equal(error.layout?.kind, kind, error.message);
    assert.equal(error.layout.startLine, start);
    assert.match(error.message, /Example layout:/);
    assert.doesNotThrow(() => compile(error.layout.example));
  }
  const parenthesis = failure('print (\n    1 + 2\n)');
  assert.equal(parenthesis.relatedInformation[0].column, 7);
  assert.match(parenthesis.message, /including a separate closing parenthesis/);
});

test('leading logical lines distinguish conditions from continued values and inline bodies', () => {
  const value = failure('ready is true\n    and false');
  assert.equal(value.layout.kind, 'leading-value');
  assert.match(value.message, /put and at the end of that line/);
  const condition = failure('if true then print 1\nor false');
  assert.equal(condition.layout.kind, 'leading-condition');
  assert.match(condition.message, /before any body starts/);
  assert.doesNotThrow(() => compile(condition.layout.example));
});

test('conditional-value errors explain else alignment without changing valid block if statements', () => {
  const error = failure('print "yes"\n    if true\nelse "no"');
  assert.equal(error.layout.kind, 'conditional-else');
  assert.match(error.message, /align else with the indented if/);
  assert.equal(error.relatedInformation[1].line, 3);
  assert.doesNotThrow(() => compile(error.layout.example));
  const empty = failure('print "yes"\n    if true\n    else');
  assert.equal(empty.layout.kind, 'conditional-else-value');
  assert.equal(empty.relatedInformation[0].line, 3);
  assert.match(empty.message, /fallback value after else/);
  const source = 'function done\n    return "yes"\n    if true\n        return "no"\nprint done run';
  assert.doesNotThrow(() => compile(source));
});

test('wrapped parameter errors distinguish a closed header from an unfinished parameter list', () => {
  for (const [source, kind] of [
    ['function combine takes\n    first as number\n    second as number\ngiving number\n    return first + second', 'function-header'],
    ['function greet\ngiving text\n    return "hello"', 'function-header'],
    ['function combine takes\n    first,\n    second,\n    return first + second', 'header-comma']
  ]) {
    const error = failure(source);
    assert.equal(error.layout?.kind, kind, error.message);
    assert.match(error.message, /comma/);
    assert.equal(error.relatedInformation[0].line, 1);
    assert.doesNotThrow(() => compile(error.layout.example));
  }
});

test('object and type fields receive their own layout examples', () => {
  for (const [source, kind] of [
    ['point is object\n    x is 1\n        y is 2', 'object'],
    ['type Point is object\n    x as number\n        y as number', 'type']
  ]) {
    const error = failure(source);
    assert.equal(error.layout.kind, kind);
    assert.match(error.message, /Fields at the same level must align/);
    assert.doesNotThrow(() => compile(error.layout.example));
  }
});

test('tabs, CRLF, blank lines, and quoted keyword text keep physical source locations', () => {
  const source = ['"😀 function giving ("', '', 'function calculate', '\ttotal is 1', '\t\t+ 2'].join('\r\n');
  const error = failure(source);
  assert.equal(error.line, 5);
  assert.equal(error.column, 3);
  assert.equal(error.relatedInformation[0].line, 4);
  assert.equal(error.relatedInformation[0].column, 2);
  assert.equal(error.layout.kind, 'indent');
  assert.equal(failure('print "unterminated').layout, undefined);
  assert.equal(failure('print missing').layout, undefined);
  assert.equal(failure('print Math.max 1, 2').layout, undefined);
  assert.equal(failure('point is object\n    giving is 1\n        nested is 2').layout.kind, 'object');
});

test('supported wrapping keeps the same successful parse and emitted code', () => {
  const source = 'function choose takes ready\n    return "yes"\n        if ready\n        else "no"\nprint choose true';
  const inline = source.replace('\n        if ready\n        else "no"', ' if ready else "no"');
  const meaning = source => JSON.stringify(parse(source), (key, value) => key === 'line' ? undefined : value);
  assert.equal(meaning(source), meaning(inline));
  assert.equal(compile(source).code, compile(inline).code);
});
