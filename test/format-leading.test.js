import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { format } from "../src/format.js";
import { compile, parse } from "../src/transpile.js";

const meaning = source => JSON.stringify(parse(source), (key, value) => key === "line" ? undefined : value);
function layout(source, expected, options = {}) {
  const result = format(source, options);
  assert.equal(result, expected);
  assert.equal(meaning(result), meaning(source));
  assert.equal(format(result, options), result);
  assert.ok(result.split(/\r?\n/).every(line => line.replace(/\t/g, ' '.repeat(options.tabWidth ?? 4)).length <= (options.width ?? 80)));
}

test("automatic condition reflow puts and/or before the next operand at header indentation", () => {
  layout(
    'function accepts takes record\n    if record.first_flag and record.second_flag or record.third_flag and record.fourth_flag\n        return true\n    else if record.fifth_flag and record.sixth_flag\n        return false',
    'function accepts takes record\n    if record.first_flag\n    and record.second_flag\n    or record.third_flag\n    and record.fourth_flag\n        return true\n    else if record.fifth_flag\n    and record.sixth_flag\n        return false\n',
    { width: 40 }
  );
  layout(
    'while first_condition and second_condition or third_condition and fourth_condition\n    break',
    'while first_condition and second_condition\nor third_condition and fourth_condition\n    break\n',
    { width: 80 }
  );
});

test("automatic conditional value reflow gives if and else their own indented lines", () => {
  layout(
    'labels is books.map function takes book\n    return book.title + " (long)" if book.pages > 500 else book.title',
    'labels is books.map function takes book\n    return book.title + " (long)"\n        if book.pages > 500\n        else book.title\n',
    { width: 60 }
  );
  layout(
    'label is first_result if first_condition and second_condition or third_condition else second_result',
    'label is first_result\n    if first_condition\n    and second_condition\n    or third_condition\n    else second_result\n',
    { width: 40 }
  );
  layout(
    'record is object\n    label is first_result if first_condition and second_condition else second_result',
    'record is object\n    label is first_result\n        if first_condition\n        and second_condition\n        else second_result\n',
    { width: 40 }
  );
  layout(
    'labels is books.map function takes book return book.title + " (long)" if book.pages > 500 else book.title',
    'labels is books.map function takes book return book.title + " (long)"\n    if book.pages > 500\n    else book.title\n'
  );
});

test("fitting manual layouts keep their breaks even when they use trailing operators", () => {
  const source = [
    'if first_condition and', '      second_condition', '    print "yes"',
    'label is first_result if first_condition', '    else second_result',
    'print first_result', '      if first_condition', '      else second_result', ''
  ].join('\n');
  layout(source, source);
});

test("reflowed clauses honor tabs, CRLF, and editor indentation width", () => {
  layout(
    'function choose\r\n\treturn first_result if first_condition and second_condition else second_result',
    'function choose\r\n\treturn first_result\r\n\t\tif first_condition\r\n\t\tand second_condition\r\n\t\telse second_result\r\n',
    { width: 40, tabWidth: 2, insertSpaces: false }
  );
});

test("reflow preserves grouped logic, keyword properties, call boundaries, and callback bodies", () => {
  const sources = [
    'if first_condition and second_condition or third_condition then print "yes"',
    'value is if first_condition and second_condition or third_condition then first_result else second_result',
    'value is (first_result if first_condition and second_condition else second_result)',
    'print ("inner" if first_condition and second_condition else "other") if third_condition or fourth_condition else "outer"',
    'if (first_condition and second_condition) or (third_condition and fourth_condition)\n    print "yes"',
    'answer is object if is first_result if first_condition and second_condition else second_result, else is "fallback"',
    'function pick\n    return function takes value if first_condition and second_condition else fallback_function\n        return value',
    'if values.some function takes value return value.first_flag and value.second_flag\n    print "yes"',
    'result is first_condition and second_condition or third_condition',
    'function choose\n    return first_condition and second_condition or third_condition',
    'if outer_condition then print first_result if first_condition and second_condition else second_result',
    'if outer_condition then print if first_condition and second_condition then first_result else second_result',
    'function choose\n    if outer_condition then return first_result if first_condition and second_condition else second_result',
    'function choose\n    if outer_condition then return function takes value return first_result if first_condition and second_condition else second_result',
    'flags is object\n    and is first_result if first_condition else second_result\n    or is third_result\nprint flags.and or flags.or'
  ];
  for (const source of sources) for (const width of [20, 24, 32, 40, 60, 80]) {
    const result = format(source, { width });
    assert.equal(meaning(result), meaning(source), `${width}: ${source}`);
    assert.equal(format(result, { width }), result, `${width}: ${source}`);
  }
});

test("reflow preserves short-circuit logic and evaluates only the chosen conditional branch", () => {
  const source = [
    'function noisy takes label', '    print label', '    return true',
    'if true or noisy "unexpected first" and noisy "unexpected second"', '    print "selected"',
    'if false and noisy "unexpected third" or false', '    print "unexpected body"',
    'else if true and true or noisy "unexpected fourth"', '    print "fallback"',
    'count is 0', 'while count < 2 and count >= 0 or false', '    count is count + 1',
    'print count',
    'print noisy "chosen branch" if true or noisy "unexpected condition" else noisy "unexpected branch"',
    'function inline_choice takes ready',
    '    if ready then return noisy "inline chosen" if true or noisy "inline unexpected condition" else noisy "inline unexpected branch"',
    '    return false', 'print inline_choice true'
  ].join('\n');
  const run = text => {
    const output = [];
    runInNewContext(compile(text).code, { console: { log: value => output.push(value) } }, { timeout: 1000 });
    return output;
  };
  const expected = ['selected', 'fallback', 2, 'chosen branch', true, 'inline chosen', true];
  assert.deepEqual(run(source), expected);
  for (const width of [20, 32, 48, 80]) assert.deepEqual(run(format(source, { width })), expected);
});
