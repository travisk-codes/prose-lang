import { compile, transpile } from "prose-lang";
import { format } from "prose-lang/format";
import { checkProject, CheckSetupError } from "prose-lang/check";
import prose from "prose-lang/vite";

const result = compile("print 1");
const code: string = result.code;
const declarations: string | null = result.declarations;
const source: string = transpile("print 1");
const formatted: string = format(source, { width: 80 });
const plugin = prose({ declarations: true });
const checked = checkProject({ cwd: ".", targets: ["."] });
const setup = new CheckSetupError("setup", checked.diagnostics);

void code;
void declarations;
void formatted;
void plugin;
void setup;
