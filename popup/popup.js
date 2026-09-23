const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_QUESTIONS = [
  {
    id: "slop",
    type: "score",
    instructions: "How likely is this text AI slop",
    criteria: ["Likely human", "50/50 slop", "AI Slop"],
  },
];

const DEFAULTS = {
  apiKey: "",
  questions: DEFAULT_QUESTIONS,
  minWords: 25,
  model: "jev-latest",
};

const $ = (id) => document.getElementById(id);

// Working copy. The DOM is rebuilt from this on every structural change, so
// edits in inputs are flushed back here first (see syncFromDom).
let questions = [];

// ---------- criteria shapes ----------
//
// score:  ordered array of level descriptions, low -> high
// choice: object of option name -> description (or null)
// noul:   optional object with "true" / "false" descriptions
//
// Switching type has to convert between these or the API 422s.

function convertCriteria(criteria, from, to) {
  if (from === to) return criteria;

  const asList = Array.isArray(criteria)
    ? criteria
    : Object.entries(criteria ?? {}).map(([k, v]) => (typeof v === "string" && v ? `${k}: ${v}` : k));

  if (to === "score") return asList.length >= 2 ? asList : ["Low", "High"];
  if (to === "choice") {
    if (!Array.isArray(criteria) && criteria && typeof criteria === "object") return criteria;
    const entries = asList.map((label, i) => [slug(label) || `option_${i + 1}`, ""]);
    return Object.fromEntries(entries.length >= 2 ? entries : [["yes", ""], ["no", ""]]);
  }
  return {}; // noul: start with no criteria, they're optional
}

function slug(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

// ---------- rendering ----------

function iconButton(glyph, title, disabled, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon";
  b.textContent = glyph;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

function textInput(value, placeholder, onInput) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.placeholder = placeholder ?? "";
  input.spellcheck = false;
  input.addEventListener("input", onInput);
  return input;
}

function renderScoreCriteria(q, host) {
  const list = document.createElement("ul");
  q.criteria.forEach((level, i) => {
    const li = document.createElement("li");
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = i;

    li.append(
      idx,
      textInput(level, "level description", (e) => {
        q.criteria[i] = e.target.value;
      }),
      iconButton("↑", "Move up", i === 0, () => {
        [q.criteria[i - 1], q.criteria[i]] = [q.criteria[i], q.criteria[i - 1]];
        render();
      }),
      iconButton("↓", "Move down", i === q.criteria.length - 1, () => {
        [q.criteria[i + 1], q.criteria[i]] = [q.criteria[i], q.criteria[i + 1]];
        render();
      }),
      iconButton("×", "Remove level", q.criteria.length <= 2, () => {
        q.criteria.splice(i, 1);
        render();
      }),
    );
    list.appendChild(li);
  });
  host.appendChild(list);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "ghost";
  add.textContent = "+ Add level";
  add.disabled = q.criteria.length >= 10; // API caps score at 10 levels
  add.addEventListener("click", () => {
    q.criteria.push("");
    render();
  });
  host.appendChild(add);
}

function renderChoiceCriteria(q, host) {
  const entries = Object.entries(q.criteria ?? {});
  const list = document.createElement("ul");

  entries.forEach(([key, value], i) => {
    const li = document.createElement("li");
    const keyInput = textInput(key, "option_name", (e) => {
      const next = Object.entries(q.criteria);
      next[i] = [e.target.value, value];
      q.criteria = Object.fromEntries(next);
    });
    keyInput.className = "key";

    li.append(
      keyInput,
      textInput(value ?? "", "when to pick it", (e) => {
        q.criteria[key] = e.target.value;
      }),
      iconButton("×", "Remove option", entries.length <= 2, () => {
        delete q.criteria[key];
        render();
      }),
    );
    list.appendChild(li);
  });
  host.appendChild(list);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "ghost";
  add.textContent = "+ Add option";
  add.addEventListener("click", () => {
    q.criteria[`option_${Object.keys(q.criteria).length + 1}`] = "";
    render();
  });
  host.appendChild(add);
}

function renderNoulCriteria(q, host) {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "Optional. Describe what counts as true or false; leave blank to omit.";
  host.appendChild(note);

  const list = document.createElement("ul");
  for (const key of ["true", "false"]) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "idx wide";
    label.textContent = key;
    li.append(
      label,
      textInput(q.criteria?.[key] ?? "", `what counts as ${key}`, (e) => {
        q.criteria = q.criteria ?? {};
        if (e.target.value.trim()) q.criteria[key] = e.target.value;
        else delete q.criteria[key];
      }),
    );
    list.appendChild(li);
  }
  host.appendChild(list);
}

function renderQuestion(q, index) {
  const box = document.createElement("div");
  box.className = "qbox";

  const head = document.createElement("div");
  head.className = "qhead";

  const idInput = textInput(q.id, "id", (e) => {
    q.id = e.target.value;
  });
  idInput.className = "key";
  idInput.title = "Identifier used as the key in the API request";

  const typeSelect = document.createElement("select");
  for (const t of ["score", "choice", "noul"]) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    opt.selected = q.type === t;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener("change", (e) => {
    q.criteria = convertCriteria(q.criteria, q.type, e.target.value);
    q.type = e.target.value;
    render();
  });

  head.append(
    idInput,
    typeSelect,
    iconButton("×", "Remove question", questions.length <= 1, () => {
      questions.splice(index, 1);
      render();
    }),
  );
  box.appendChild(head);

  const instructions = document.createElement("textarea");
  instructions.rows = 2;
  instructions.spellcheck = false;
  instructions.value = q.instructions;
  instructions.placeholder = q.type === "noul" ? "A yes/no proposition" : "What to evaluate";
  instructions.addEventListener("input", (e) => {
    q.instructions = e.target.value;
  });
  box.appendChild(instructions);

  if (q.type === "score") renderScoreCriteria(q, box);
  else if (q.type === "choice") renderChoiceCriteria(q, box);
  else renderNoulCriteria(q, box);

  return box;
}

function render() {
  const host = $("questions");
  host.textContent = "";
  questions.forEach((q, i) => host.appendChild(renderQuestion(q, i)));
}

// ---------- shortcut ----------
//
// Firefox implements commands.update(), so we can record a new binding right
// here. Chrome has no such API — the only way is its own shortcuts page.

const canRebind = typeof api.commands?.update === "function";

const NAMED_KEYS = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  " ": "Space", ",": "Comma", ".": "Period",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Insert: "Insert", Delete: "Delete",
};

// Returns a manifest-format shortcut string, or an error message explaining
// why this keystroke isn't a legal binding.
function toShortcut(event) {
  const onMac = navigator.platform.toUpperCase().includes("MAC");

  const primary = [];
  if (event.metaKey) primary.push("Command");
  // On macOS the Control key is "MacCtrl"; everywhere else it's "Ctrl".
  if (event.ctrlKey) primary.push(onMac ? "MacCtrl" : "Ctrl");
  if (event.altKey) primary.push("Alt");

  let key = null;
  if (/^[a-zA-Z]$/.test(event.key)) key = event.key.toUpperCase();
  else if (/^[0-9]$/.test(event.key)) key = event.key;
  else if (/^F([1-9]|1[0-2])$/.test(event.key)) key = event.key;
  else if (NAMED_KEYS[event.key]) key = NAMED_KEYS[event.key];

  if (!key) return { error: "That key can't be used in a shortcut." };
  // Function keys may stand alone; everything else needs a primary modifier.
  if (!primary.length && !/^F/.test(key)) return { error: "Add Ctrl, Alt or Command." };
  if (primary.length > 1) return { error: "Use only one of Ctrl, Alt or Command." };

  return { shortcut: [...primary, ...(event.shiftKey ? ["Shift"] : []), key].join("+") };
}

let recording = false;

async function showShortcut() {
  const commands = await api.commands.getAll();
  const cmd = commands.find((c) => c.name === "toggle-sniff");
  $("shortcut").textContent = cmd?.shortcut || "not set";
  $("shortcutHint").textContent = canRebind
    ? "Click Change, then press the combination you want."
    : "Opens chrome://extensions/shortcuts — Chrome only rebinds there.";
}

function stopRecording() {
  recording = false;
  window.removeEventListener("keydown", onRecordKey, true);
  $("editShortcut").textContent = "Change";
  $("shortcut").classList.remove("recording");
}

async function onRecordKey(event) {
  event.preventDefault();
  event.stopPropagation();

  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return; // still building
  if (event.key === "Escape") {
    stopRecording();
    showShortcut();
    return;
  }

  const { shortcut, error } = toShortcut(event);
  if (error) {
    $("shortcutHint").textContent = error;
    return;
  }

  try {
    await api.commands.update({ name: "toggle-sniff", shortcut });
    stopRecording();
    await showShortcut();
    $("shortcutHint").textContent = "Saved. Reserved browser shortcuts may not stick.";
  } catch (err) {
    $("shortcutHint").textContent = `Rejected: ${err?.message ?? err}`;
  }
}

$("editShortcut").addEventListener("click", async () => {
  if (canRebind) {
    if (recording) {
      stopRecording();
      showShortcut();
      return;
    }
    recording = true;
    $("shortcut").textContent = "Press keys…";
    $("shortcut").classList.add("recording");
    $("editShortcut").textContent = "Cancel";
    $("shortcutHint").textContent = "Esc to cancel.";
    window.addEventListener("keydown", onRecordKey, true);
    return;
  }

  // Chrome: chrome:// URLs can't be plain links, but tabs.create accepts them.
  const url = "chrome://extensions/shortcuts";
  try {
    await api.tabs.create({ url });
    window.close();
  } catch {
    $("shortcutHint").textContent = `Open ${url} manually to rebind.`;
  }
});

// ---------- save ----------

function validate(list) {
  const seen = new Set();
  for (const q of list) {
    const id = slug(q.id);
    if (!id) return "Every question needs an id.";
    if (seen.has(id)) return `Duplicate question id "${id}".`;
    seen.add(id);

    if (!q.instructions.trim()) return `"${id}" needs instructions.`;
    if (q.type === "score") {
      const levels = q.criteria.filter((c) => c.trim());
      if (levels.length < 2) return `"${id}" needs at least 2 levels.`;
    }
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria).filter((k) => k.trim());
      if (keys.length < 2) return `"${id}" needs at least 2 options.`;
    }
  }
  return null;
}

function normalize(list) {
  return list.map((q) => {
    const out = { id: slug(q.id), type: q.type, instructions: q.instructions.trim() };
    if (q.type === "score") {
      out.criteria = q.criteria.map((c) => c.trim()).filter(Boolean);
    } else if (q.type === "choice") {
      out.criteria = Object.fromEntries(
        Object.entries(q.criteria)
          .filter(([k]) => k.trim())
          .map(([k, v]) => [slug(k), v?.trim() ? v.trim() : null]),
      );
    } else {
      const entries = Object.entries(q.criteria ?? {}).filter(([, v]) => v?.trim());
      out.criteria = Object.fromEntries(entries.map(([k, v]) => [k, v.trim()]));
    }
    return out;
  });
}

$("addQuestion").addEventListener("click", () => {
  questions.push({
    id: `question_${questions.length + 1}`,
    type: "noul",
    instructions: "",
    criteria: {},
  });
  render();
});

$("save").addEventListener("click", async () => {
  const status = $("status");
  const problem = validate(questions);
  if (problem) {
    status.textContent = problem;
    status.className = "bad";
    return;
  }

  questions = normalize(questions);
  await api.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    questions,
    minWords: Math.max(1, Number($("minWords").value) || DEFAULTS.minWords),
    model: $("model").value.trim() || DEFAULTS.model,
  });

  render();
  status.textContent = "Saved";
  status.className = "good";
  setTimeout(() => (status.textContent = ""), 1500);
});

(async function init() {
  const s = { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) };
  $("apiKey").value = s.apiKey;
  $("minWords").value = s.minWords;
  $("model").value = s.model;

  // Migrate the pre-multi-question layout.
  questions = Array.isArray(s.questions) && s.questions.length
    ? structuredClone(s.questions)
    : structuredClone(DEFAULT_QUESTIONS);
  if (typeof s.question === "string" && !Array.isArray(s.questions)) {
    questions = [{ id: "slop", type: "score", instructions: s.question, criteria: s.criteria ?? DEFAULT_QUESTIONS[0].criteria }];
  }

  render();
  showShortcut();
})();
