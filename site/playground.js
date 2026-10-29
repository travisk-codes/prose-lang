(() => {
  // Highlighting for the editor, matching the VS Code grammar's main rules.
  const control = new Set(["if", "then", "else", "for", "each", "in", "while", "return"]);
  const languageWords = new Set(["is", "to", "print", "run", "with", "new", "use", "export", "takes", "type"]);
  const operatorWords = new Set(["and", "or", "not", "mod", "otherwise", "maybe"]);
  const constants = new Set(["true", "false", "null", "unset"]);
  const builtins = new Set(["length", "char_to_number", "number_to_char", "remainder"]);
  const typeWords = new Set(["list", "set", "map", "of", "from", "to", "taking", "giving", "or", "and", "maybe", "function"]);
  const escapeHtml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const wrap = (classes, text) => `<span class="${classes}">${escapeHtml(text)}</span>`;

  function highlightLine(line) {
    if (/^\s*"(?:[^"\\]|\\.)*"\s*$/.test(line)) return wrap("c-comment it", line);
    const binding = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s+(?:is|as)\b/d.exec(line);
    const bindingAt = binding ? binding.indices[1][0] : -1;
    const pattern = /("(?:[^"\\]|\\.)*"?)|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|(<=|>=|!=|[=<>+*\/%-])|([:.])|([(),])|(\s+)|([\s\S])/g;
    let html = "", match, previous = "", inParams = false, inType = false, inLoop = false, loopNext = false, afterFunction = false;
    while ((match = pattern.exec(line))) {
      const [text, string, number, word, operator, accessor, punct, space] = match;
      if (space) { html += text; continue; }
      let classes = "c-plain";
      if (string) classes = "c-green";
      else if (number) classes = "c-orange";
      else if (operator) classes = "c-pink";
      else if (accessor) classes = "c-teal2";
      else if (punct) {
        classes = "c-punct";
        if (text === ",") inType = false;
      } else if (word) {
        if (inType && (word === "is" || word === "return")) inType = false;
        if (match.index === bindingAt) classes = "c-blue";
        else if (inType) classes = typeWords.has(word) ? "c-purple" : /^[A-Z]/.test(word) || ["text", "number", "boolean", "any", "nothing", "object"].includes(word) || constants.has(word) ? "c-rose" : "c-rose it";
        else if (previous === ":") classes = "c-teal";
        else if (afterFunction && !["takes", "return", "giving"].includes(word)) classes = "c-yellow bd";
        else if (control.has(word)) classes = "c-red";
        else if (word === "function") classes = "c-yellow";
        else if (word === "as" || word === "giving") { classes = "c-purple"; inType = true; }
        else if (languageWords.has(word)) classes = "c-purple";
        else if (operatorWords.has(word)) classes = "c-pink";
        else if (constants.has(word)) classes = "c-amber";
        else if (builtins.has(word)) classes = "c-cyan";
        else if (word === "object" || word === "array") classes = "c-indigo";
        else if (inParams) classes = "c-lime it";
        else if (inLoop || loopNext) classes = "c-lime";
        else if (/^[A-Z]/.test(word)) classes = "c-rose";
        else classes = "c-pale";
        afterFunction = word === "function";
        if (word === "takes") inParams = true;
        if (word === "return") inParams = false;
        if (word === "each" && previous === "for") inLoop = true;
        if (word === "in") inLoop = false;
        loopNext = word === "for";
      }
      if (!word) afterFunction = loopNext = false;
      html += wrap(classes, text);
      previous = text;
    }
    return html;
  }

  const source = document.getElementById("source");
  const highlight = document.getElementById("highlight");
  const viewport = document.getElementById("highlight-viewport");
  const output = document.getElementById("output");
  const compiled = document.getElementById("compiled");
  const status = document.getElementById("status");
  const picker = document.getElementById("example");
  const automatic = document.getElementById("auto-run");
  const position = document.getElementById("cursor-position");
  const examples = JSON.parse(document.getElementById("examples").textContent);
  let worker = null;
  let workerTimeout = null;
  let timer = null;
  let layoutFrame = null;

  for (const [index, example] of examples.entries()) picker.add(new Option(example.name, String(index)));

  function syncEditor() {
    // Only the textarea scrolls. Translate the painted text without a second
    // scroll container clamping it to a different maximum after a resize.
    viewport.style.width = source.clientWidth + "px";
    viewport.style.height = source.clientHeight + "px";
    highlight.style.minWidth = source.clientWidth + "px";
    highlight.style.transform = "translate(" + -source.scrollLeft + "px, " + -source.scrollTop + "px)";
  }

  function requestLayout() {
    if (layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      syncEditor();
    });
  }

  function updatePosition() {
    const before = source.value.slice(0, source.selectionStart);
    const lines = before.split("\n");
    position.textContent = "Ln " + lines.length + ", Col " + (Array.from(lines.at(-1)).length + 1);
  }

  function render() {
    highlight.innerHTML = source.value.split("\n").map(highlightLine).join("\n") + "\n";
    syncEditor();
    updatePosition();
  }

  source.addEventListener("scroll", syncEditor, { passive: true });
  source.addEventListener("select", updatePosition);
  source.addEventListener("click", updatePosition);
  source.addEventListener("keyup", updatePosition);
  window.addEventListener("resize", requestLayout, { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(requestLayout).observe(source);
  if (document.fonts) {
    document.fonts.ready.then(requestLayout);
    document.fonts.addEventListener("loadingdone", requestLayout);
  }

  source.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      update();
      return;
    }
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    source.setRangeText("    ", source.selectionStart, source.selectionEnd, "end");
    render();
    schedule();
  });

  function setStatus(text, kind = "success") {
    if (status.textContent !== text) status.textContent = text;
    status.dataset.state = kind;
    document.getElementById("results-pane").setAttribute("aria-busy", String(kind === "running"));
  }

  function cancelRun() {
    clearTimeout(workerTimeout);
    workerTimeout = null;
    if (worker) worker.terminate();
    worker = null;
  }

  const workerSource = `
    const show = (value, nested, depth) => {
      if (typeof value === "string") return nested ? "'" + value + "'" : value;
      if (value === undefined) return "undefined";
      if (typeof value === "function") return "[Function]";
      if (depth > 3) return "…";
      if (Array.isArray(value)) return value.length ? "[ " + value.map(item => show(item, true, depth + 1)).join(", ") + " ]" : "[]";
      if (value instanceof Map) return "Map(" + value.size + ") { " + [...value].map(([key, item]) => show(key, true, depth + 1) + " => " + show(item, true, depth + 1)).join(", ") + " }";
      if (value instanceof Set) return "Set(" + value.size + ") { " + [...value].map(item => show(item, true, depth + 1)).join(", ") + " }";
      if (value && typeof value === "object") {
        const entries = Object.entries(value);
        return entries.length ? "{ " + entries.map(([key, item]) => key + ": " + show(item, true, depth + 1)).join(", ") + " }" : "{}";
      }
      return String(value);
    };
    self.onmessage = event => {
      const lines = [];
      const log = (...values) => { if (lines.length < 2000) lines.push(values.map(value => show(value, false, 0)).join(" ")); };
      try {
        new Function("console", event.data)({ log });
        self.postMessage({ lines });
      } catch (error) {
        self.postMessage({ lines, error: String((error && error.message) || error), name: error && error.name });
      }
    };`;

  let workerUrl = null;
  try { workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })); } catch {}

  function run(code) {
    cancelRun();
    output.textContent = "";
    let current;
    try {
      current = worker = new Worker(workerUrl);
    } catch {
      worker = null;
      setStatus("This browser cannot run the program here. You can still read its JavaScript in Compiled.", "error");
      return;
    }
    setStatus("Running your program…", "running");
    workerTimeout = setTimeout(() => {
      if (worker !== current) return;
      cancelRun();
      setStatus("Stopped after 2 seconds. Check for a loop that never ends.", "error");
    }, 2000);
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      cancelRun();
      output.textContent = data.lines.join("\n");
      if (!data.error) setStatus(data.lines.length ? "Compiled and ran." : "Compiled and ran. Nothing was printed.");
      else if (data.name === "EvalError" || /unsafe-eval|Content Security Policy/i.test(data.error)) {
        setStatus("This browser cannot run the program here. You can still read its JavaScript in Compiled.", "error");
      } else setStatus(data.error, "error");
    };
    current.onerror = event => {
      if (worker !== current) return;
      event.preventDefault();
      cancelRun();
      setStatus(event.message || "The program could not run. Try a different example.", "error");
    };
    current.postMessage(code);
  }

  function update() {
    clearTimeout(timer);
    cancelRun();
    let shown, runnable;
    try {
      shown = Prose.compile(source.value, { runtime: "prose-runtime" });
      runnable = Prose.compile(source.value);
    } catch (error) {
      output.textContent = "";
      compiled.textContent = "";
      setStatus(error.message, "error");
      return;
    }
    const javascript = shown.code.split("\n").filter(line => !line.startsWith("import {")).join("\n").trim();
    compiled.innerHTML = Prism.highlight(javascript, Prism.languages.javascript, "javascript");
    if (runnable.module) {
      output.textContent = "";
      setStatus("Programs with use or export need a bundler to run. Their JavaScript is ready in Compiled.", "idle");
      return;
    }
    run(runnable.code);
  }

  function schedule() {
    clearTimeout(timer);
    cancelRun();
    if (automatic.checked) {
      setStatus("Compiling shortly…", "running");
      timer = setTimeout(update, 300);
    } else {
      setStatus("Changes ready. Press Run to try your program.", "idle");
    }
  }

  source.addEventListener("input", () => { render(); schedule(); });
  document.getElementById("run-program").addEventListener("click", update);
  document.getElementById("reset-program").addEventListener("click", () => {
    source.value = examples[Number(picker.value)].source;
    source.scrollTop = source.scrollLeft = 0;
    source.setSelectionRange(0, 0);
    render();
    update();
    source.focus({ preventScroll: true });
  });
  automatic.addEventListener("change", () => {
    if (automatic.checked) update();
    else {
      clearTimeout(timer);
      cancelRun();
      setStatus("Auto-run is paused. Press Run whenever you are ready.", "idle");
    }
  });
  picker.addEventListener("change", () => {
    source.value = examples[Number(picker.value)].source;
    source.scrollTop = source.scrollLeft = 0;
    source.setSelectionRange(0, 0);
    render();
    update();
  });

  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  function activateTab(tab) {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")).hidden = !selected;
    }
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", event => {
      const index = tabs.indexOf(tab);
      const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft" ? tabs[(index - 1 + tabs.length) % tabs.length]
        : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : null;
      if (!next) return;
      event.preventDefault();
      activateTab(next);
      next.focus();
    });
  }

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(target.textContent);
        button.textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = "Selected";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1600);
    });
  }

  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    cancelRun();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
  });
  render();
  update();
})();
