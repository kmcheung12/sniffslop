(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const DWELL_MS = 400;
  const BLOCK_TAGS = new Set([
    "P", "LI", "BLOCKQUOTE", "DD", "DT", "FIGCAPTION",
    "H1", "H2", "H3", "H4", "H5", "H6", "TD", "SECTION", "ARTICLE", "DIV",
  ]);
  const SKIP_CLOSEST = "nav, header, footer, aside, code, pre, script, style, textarea, form, [contenteditable='true']";

  let armed = false;
  let minWords = 25;
  let dwellTimer = null;
  let current = null; // element under cursor that we are tracking
  const cache = new Map(); // text hash -> { state: 'pending'|'done'|'error', result?, error? }

  // `mouseover` only fires on entering a new element, so arming while the
  // cursor already rests on a paragraph would otherwise do nothing until the
  // pointer crossed a boundary. Track the position continuously and probe it.
  let lastX = 0;
  let lastY = 0;
  let havePoint = false;

  let card = null;
  let toast = null;

  // ---------- eligibility ----------

  function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Walk up from the hovered node to the tightest block that carries enough
  // text on its own. Containers that merely wrap other blocks are skipped so we
  // highlight the paragraph, not the whole article.
  function findBlock(node) {
    let el = node instanceof Element ? node : node?.parentElement;
    while (el && el !== document.body) {
      if (el.closest(SKIP_CLOSEST)) return null;
      if (BLOCK_TAGS.has(el.tagName) && isVisible(el)) {
        const text = (el.innerText ?? "").trim();
        if (wordCount(text) >= minWords) {
          const nestedBlock = Array.from(el.children).find(
            (c) => BLOCK_TAGS.has(c.tagName) && wordCount((c.innerText ?? "").trim()) >= minWords,
          );
          if (!nestedBlock) return { el, text };
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function hashText(text) {
    // FNV-1a — fast, good enough as a cache key for page-lifetime text.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // ---------- answer interpretation ----------

  function sortedLevels(legend) {
    return Object.keys(legend ?? {}).sort((a, b) => Number(a) - Number(b));
  }

  function maxLevel(answer) {
    return Math.max(1, sortedLevels(answer.legend).length - 1);
  }

  // Position on a 0..1 scale, used for the outline colour. Choice answers have
  // no inherent ordering, so they deliberately return null.
  function ratioOf(item) {
    const a = item.answer;
    if (item.type === "score" && typeof a.score === "number") {
      return Math.min(1, Math.max(0, a.score / maxLevel(a)));
    }
    if (item.type === "noul" && typeof a.noul === "number") {
      return Math.min(1, Math.max(0, a.noul));
    }
    return null;
  }

  // 140deg (green) -> 0deg (red), passing through amber. Certainty drains the
  // saturation: an ambiguous answer looks washed out rather than confidently
  // green or red.
  function colorFor(ratio, certainty = 1) {
    const sat = Math.round(18 + 54 * Math.min(1, Math.max(0, certainty)));
    return `hsl(${Math.round(140 * (1 - ratio))}, ${sat}%, 44%)`;
  }

  // How concentrated the answer is, 0..1. For score and choice the API hands us
  // this directly. A noul has no confidence field — but a probability near 0.5
  // is the same kind of "can't tell", so derive it from the distance to the
  // midpoint.
  function certaintyOf(item) {
    const a = item.answer;
    if (typeof a.confidence === "number") return a.confidence;
    if (item.type === "noul" && typeof a.noul === "number") return Math.abs(2 * a.noul - 1);
    return 1;
  }

  // The first question that maps onto a scale drives the outline colour.
  function outlineColor(items) {
    for (const item of items) {
      const ratio = ratioOf(item);
      if (ratio !== null) return colorFor(ratio, certaintyOf(item));
    }
    return "#7aa2f7";
  }

  // ---------- presentation ----------

  function ensureCard() {
    if (card) return card;
    card = document.createElement("div");
    card.className = "sniffslop-card";
    card.setAttribute("role", "tooltip");
    document.documentElement.appendChild(card);
    return card;
  }

  function positionCard(el) {
    const c = ensureCard();
    const rect = el.getBoundingClientRect();
    c.style.visibility = "hidden";
    c.style.display = "block";
    const cardRect = c.getBoundingClientRect();
    let top = rect.top - cardRect.height - 8;
    if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - cardRect.height - 8);
    let left = rect.left;
    if (left + cardRect.width > window.innerWidth - 8) left = window.innerWidth - cardRect.width - 8;
    c.style.top = `${Math.max(8, top)}px`;
    c.style.left = `${Math.max(8, left)}px`;
    c.style.visibility = "visible";
  }

  function barRow(name, fraction, color) {
    const row = document.createElement("div");
    row.className = "sniffslop-bar-row";

    const label = document.createElement("span");
    label.className = "sniffslop-bar-name";
    label.textContent = name;
    label.title = name;

    const track = document.createElement("span");
    track.className = "sniffslop-bar-track";
    const fill = document.createElement("span");
    fill.className = "sniffslop-bar-fill";
    fill.style.width = `${Math.round(fraction * 100)}%`;
    fill.style.background = color;
    track.appendChild(fill);

    const pct = document.createElement("span");
    pct.className = "sniffslop-bar-pct";
    pct.textContent = `${Math.round(fraction * 100)}%`;

    row.append(label, track, pct);
    return row;
  }

  function headRow(color, label, value) {
    const head = document.createElement("div");
    head.className = "sniffslop-head";

    const dot = document.createElement("span");
    dot.className = "sniffslop-dot";
    dot.style.background = color;

    const name = document.createElement("span");
    name.className = "sniffslop-label";
    name.textContent = label;
    name.title = label;

    const num = document.createElement("span");
    num.className = "sniffslop-num";
    num.textContent = value;

    head.append(dot, name, num);
    return head;
  }

  function renderScore(section, answer) {
    const max = maxLevel(answer);
    const ratio = Math.min(1, Math.max(0, answer.score / max));
    const idx = Math.round(answer.score);
    const label = answer.legend?.[idx] ?? answer.legend?.[String(idx)] ?? `Level ${idx}`;

    section.appendChild(headRow(colorFor(ratio), label, `${answer.score.toFixed(2)} / ${max}`));
    for (const key of sortedLevels(answer.legend)) {
      const p = Number(answer.probabilities?.[key] ?? 0);
      section.appendChild(barRow(answer.legend[key], p, colorFor(Number(key) / max)));
    }
  }

  function renderChoice(section, answer) {
    // Options are unordered, so every bar shares one neutral colour.
    section.appendChild(headRow("#7aa2f7", String(answer.choice), ""));
    const probs = answer.probabilities ?? {};
    for (const key of Object.keys(probs).sort((a, b) => probs[b] - probs[a])) {
      section.appendChild(barRow(key, Number(probs[key]), key === answer.choice ? "#7aa2f7" : "#4a4d55"));
    }
  }

  function renderNoul(section, answer) {
    // A noul is a single probability of "yes". Showing it as both a number and
    // a bar would just be the same figure twice.
    const p = Number(answer.noul ?? 0);
    const yes = p >= 0.5;
    // The percentage has to belong to the label beside it: 0.2 is "No, 80%",
    // not "No, 20%". Hue still tracks yes-ness, so it reads off the raw value.
    section.appendChild(
      headRow(colorFor(p, Math.abs(2 * p - 1)), yes ? "Yes" : "No", `${Math.round((yes ? p : 1 - p) * 100)}%`),
    );
  }

  function renderItem(item) {
    const section = document.createElement("div");
    section.className = "sniffslop-q";

    const title = document.createElement("div");
    title.className = "sniffslop-q-title";
    title.textContent = item.instructions;
    title.title = item.instructions;
    section.appendChild(title);

    if (item.type === "score") renderScore(section, item.answer);
    else if (item.type === "choice") renderChoice(section, item.answer);
    else renderNoul(section, item.answer);

    // Confidence is a function of the distribution above, so it gets no row of
    // its own — it drains the outline's saturation instead.
    return section;
  }

  function renderPending(el) {
    const c = ensureCard();
    c.innerHTML = `<div class="sniffslop-row"><span class="sniffslop-spinner"></span><span>Sniffing…</span></div>`;
    positionCard(el);
  }

  function renderError(el, message) {
    const c = ensureCard();
    c.innerHTML = `<div class="sniffslop-err"></div>`;
    c.querySelector(".sniffslop-err").textContent = message;
    positionCard(el);
  }

  function renderResult(el, result) {
    const c = ensureCard();
    c.textContent = "";
    for (const item of result.items) {
      // One malformed answer shouldn't blank the whole card.
      try {
        c.appendChild(renderItem(item));
      } catch (err) {
        console.error("[SniffSlop] bad answer", item, err);
        const bad = document.createElement("div");
        bad.className = "sniffslop-err";
        bad.textContent = `${item?.id ?? "?"}: ${err?.message ?? err}`;
        c.appendChild(bad);
      }
    }
    positionCard(el);
  }

  function hideCard() {
    if (card) card.style.display = "none";
  }

  function clearHighlight() {
    if (!current) return;
    current.el.classList.remove("sniffslop-hl", "sniffslop-hl-pending");
    current.el.style.removeProperty("--sniffslop-color");
    current = null;
  }

  function showToast(text) {
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "sniffslop-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("sniffslop-toast-on");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("sniffslop-toast-on"), 1600);
  }

  // ---------- scoring ----------

  function paintDone(el, entry) {
    el.classList.remove("sniffslop-hl-pending");
    if (entry.state === "error") {
      el.style.setProperty("--sniffslop-color", "#9aa0a6");
      renderError(el, entry.error);
      return;
    }
    // Never let a render fault leave the card hidden — that reads as "no result"
    // and hides the actual cause.
    try {
      const items = entry.result?.items;
      if (!Array.isArray(items) || !items.length) {
        throw new Error(`no items in response: ${JSON.stringify(entry.result).slice(0, 120)}`);
      }
      el.style.setProperty("--sniffslop-color", outlineColor(items));
      renderResult(el, entry.result);
    } catch (err) {
      console.error("[SniffSlop] render failed", err, entry.result);
      el.style.setProperty("--sniffslop-color", "#9aa0a6");
      renderError(el, `Render error: ${err?.message ?? err}`);
    }
  }

  async function requestScore(el, text) {
    const key = hashText(text);
    const cached = cache.get(key);

    if (cached?.state === "done" || cached?.state === "error") {
      paintDone(el, cached);
      return;
    }
    if (cached?.state === "pending") {
      renderPending(el);
      return;
    }

    cache.set(key, { state: "pending" });
    renderPending(el);

    let entry;
    try {
      const res = await api.runtime.sendMessage({ type: "score", text });
      entry = res?.ok
        ? { state: "done", result: res.result }
        : { state: "error", error: res?.error ?? "Request failed." };
    } catch (err) {
      entry = { state: "error", error: String(err?.message ?? err) };
    }
    cache.set(key, entry);

    // The cursor may have moved on while we waited — only paint if still hovered.
    if (armed && current?.el === el) paintDone(el, entry);
  }

  // ---------- events ----------

  function considerTarget(target) {
    if (!armed) return;
    const block = findBlock(target);

    if (!block) {
      clearTimeout(dwellTimer);
      clearHighlight();
      hideCard();
      return;
    }
    if (current?.el === block.el) return;

    clearTimeout(dwellTimer);
    clearHighlight();

    current = block;
    block.el.classList.add("sniffslop-hl");

    const cached = cache.get(hashText(block.text));
    if (cached?.state === "done" || cached?.state === "error") {
      paintDone(block.el, cached); // cached: instant, no dwell, no request
      return;
    }

    block.el.classList.add("sniffslop-hl-pending");
    dwellTimer = setTimeout(() => requestScore(block.el, block.text), DWELL_MS);
  }

  function onMouseOver(event) {
    considerTarget(event.target);
  }

  // Re-evaluate whatever is under the cursor right now, without waiting for the
  // pointer to move.
  function probeCursor() {
    if (!havePoint) return;
    const target = document.elementFromPoint(lastX, lastY);
    if (target) considerTarget(target);
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && armed) disarm();
  }

  function onScrollOrResize() {
    if (armed && current && card?.style.display === "block") positionCard(current.el);
  }

  async function arm() {
    const res = await api.runtime.sendMessage({ type: "settings" });
    if (res?.ok) minWords = Number(res.settings.minWords) || 25;
    armed = true;
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    showToast("SniffSlop on — hover any paragraph");
    probeCursor(); // the cursor is probably already over something
  }

  function disarm() {
    armed = false;
    clearTimeout(dwellTimer);
    clearHighlight();
    hideCard();
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    showToast("SniffSlop off");
  }

  document.addEventListener(
    "mousemove",
    (event) => {
      lastX = event.clientX;
      lastY = event.clientY;
      havePoint = true;
    },
    { passive: true, capture: true },
  );

  // Answers are only valid for the settings that produced them. When the popup
  // changes the questions, model or word threshold, everything cached is stale.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const relevant = ["questions", "model", "apiKey", "minWords"].some((k) => k in changes);
    if (!relevant) return;

    cache.clear();
    if ("minWords" in changes) minWords = Number(changes.minWords.newValue) || 25;
    if (!armed) return;

    clearTimeout(dwellTimer);
    clearHighlight();
    hideCard();
    probeCursor(); // re-score what's under the cursor with the new settings
  });

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggle") {
      if (armed) disarm();
      else arm();
    }
  });
})();
