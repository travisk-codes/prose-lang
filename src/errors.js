/** A line-numbered syntax error. Extra details (layout hints, call boundaries)
 * are copied onto the error for diagnostics and editor quick fixes. */
export function fail(line, message, details) {
  const error = new SyntaxError(`Line ${line}: ${message}`);
  error.line = line;
  if (details) Object.assign(error, details);
  throw error;
}
