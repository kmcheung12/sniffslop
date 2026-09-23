// Cross-browser API handle: Firefox exposes `browser`, Chrome exposes `chrome`.
const api = globalThis.browser ?? globalThis.chrome;

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

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
  model: "jev-latest", // required by the API; omitting it is a 422
};

async function getSettings() {
  const stored = await api.storage.local.get(DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };

  // Migrate the single-question layout (question + criteria at the top level)
  // that shipped before multi-question support.
  if (!Array.isArray(stored.questions) && typeof stored.question === "string") {
    settings.questions = [
      {
        id: "slop",
        type: "score",
        instructions: stored.question,
        criteria: stored.criteria ?? DEFAULT_QUESTIONS[0].criteria,
      },
    ];
  }
  if (!Array.isArray(settings.questions) || !settings.questions.length) {
    settings.questions = DEFAULT_QUESTIONS;
  }
  return settings;
}

// Each primitive validates differently: score wants an ordered array, choice
// wants an object of option -> description, noul wants nothing at all.
function validate(q) {
  const where = `Question "${q.id || "(unnamed)"}"`;
  if (!q.instructions?.trim()) return `${where} has no instructions.`;

  if (q.type === "score") {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
      return `${where} needs at least 2 criteria levels.`;
    }
    if (q.criteria.length > 10) return `${where} allows at most 10 levels.`;
  } else if (q.type === "choice") {
    if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) {
      return `${where} needs criteria as named options.`;
    }
    if (Object.keys(q.criteria).length < 2) return `${where} needs at least 2 options.`;
  } else if (q.type !== "noul") {
    return `${where} has unknown type "${q.type}".`;
  }
  return null;
}

function toApiQuestion(q) {
  const out = { type: q.type, instructions: q.instructions.trim() };
  // noul criteria are optional — send the key only when it carries something.
  if (q.type === "noul") {
    if (q.criteria && Object.keys(q.criteria).length) out.criteria = q.criteria;
  } else {
    out.criteria = q.criteria;
  }
  return out;
}

// The API validates with FastAPI, so errors arrive as
// { detail: [{ loc: ["body", "model"], msg: "Field required", ... }] }.
// Flatten that into something readable in the hover card.
function describeError(status, body) {
  try {
    const detail = JSON.parse(body)?.detail;
    if (typeof detail === "string") return `${status}: ${detail}`;
    if (Array.isArray(detail)) {
      return `${status}: ${detail
        .map((d) => `${(d.loc ?? []).join(".")} — ${d.msg}`)
        .join("; ")}`;
    }
  } catch {
    // not JSON; fall through to the raw body
  }
  return `${status}: ${body.slice(0, 200) || "request failed"}`;
}

// One block of text = one `state` document. All configured questions ride along
// in the same request: the API scores each independently, and the document is
// only transmitted once — far cheaper than a call per question.
async function evaluate(text) {
  const { apiKey, questions, model } = await getSettings();
  if (!apiKey) throw new Error("No API key set. Open the SniffSlop popup to add one.");

  for (const q of questions) {
    const problem = validate(q);
    if (problem) throw new Error(problem);
  }

  const payload = {
    state: text,
    model: model || DEFAULTS.model,
    questions: Object.fromEntries(questions.map((q) => [q.id, toApiQuestion(q)])),
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(describeError(res.status, body));
  }

  const json = await res.json();
  const answers = json?.answers ?? {};

  // Keep the configured order, and pair each answer with the question that
  // produced it so the hover card can label it without re-reading settings.
  const items = questions
    .filter((q) => answers[q.id])
    .map((q) => ({
      id: q.id,
      type: q.type,
      instructions: q.instructions,
      answer: answers[q.id],
    }));

  if (!items.length) {
    throw new Error(
      `No answers matched. Asked for [${questions.map((q) => q.id).join(", ")}], ` +
        `got [${Object.keys(answers).join(", ")}].`,
    );
  }
  if (items.length < questions.length) {
    const missing = questions.filter((q) => !answers[q.id]).map((q) => q.id);
    console.warn("[SniffSlop] no answer returned for:", missing);
  }
  return { items };
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "score") {
    evaluate(msg.text).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String(err.message ?? err) }),
    );
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === "settings") {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }
  return false;
});

api.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-sniff") return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await api.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch {
    // No content script here (chrome:// page, PDF viewer, store pages). Nothing to toggle.
  }
});
