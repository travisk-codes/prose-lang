/** A line-numbered syntax error. Extra details (such as layout hints) are copied
 * onto the error for diagnostics. */
export function fail(line, message, details) {
  const error = new SyntaxError(`Line ${line}: ${message}`);
  error.line = line;
  if (details) Object.assign(error, details);
  throw error;
}
