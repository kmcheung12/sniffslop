(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const DWELL_MS = 400;
  // A second click inside this window is a double-click, so a single click's
  // effect has to wait that long to know which gesture it belongs to.
  const DBLCLICK_MS = 250;
  // Hover needs a block to stand on its own, but a block the user points at
  // only has to carry text — the picked set as a whole is what gets judged
  // against minWords. A drag in particular has to take every block in the span,
  // however short, or it would quietly drop text from inside the selection.
  const PICK_MIN_WORDS = 1;
  // Reader mode picks blocks the user never pointed at, so it wants a floor high
  // enough to leave out stray one-word captions and labels.
  const READER_MIN_WORDS = 3;
  // Jev allows 32k tokens for the state plus the longest question. The popup's
  // maxWords is the user's budget inside that; this is the backstop that keeps
  // even a misconfigured budget inside the model's, estimating tokens at the
  // usual ~4 characters each.
  const MAX_STATE_TOKENS = 24000;
  const CHARS_PER_TOKEN = 4;
  const BLOCK_TAGS = new Set([
    "P", "LI", "BLOCKQUOTE", "DD", "DT", "FIGCAPTION",
    "H1", "H2", "H3", "H4", "H5", "H6", "TD", "SECTION", "ARTICLE", "DIV",
  ]);
  const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).join(",");
  const SKIP_CLOSEST = "nav, header, footer, aside, code, pre, script, style, textarea, form, [contenteditable='true']";
  const READER_ROOTS = "article, main, [role='main']";

  let armed = false;
  let minWords = 25;
  let maxWords = 20000;
  let dwellTimer = null;
  let current = null; // hover target: { els: [el], text }
  let picked = null;  // click/drag/reader target, which outranks hover
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
  function findBlock(node, floor = minWords) {
    let el = node instanceof Element ? node : node?.parentElement;
    while (el && el !== document.body) {
      if (el.closest(SKIP_CLOSEST)) return null;
      if (BLOCK_TAGS.has(el.tagName) && isVisible(el)) {
        const text = (el.innerText ?? "").trim();
        if (wordCount(text) >= floor) {
          const nestedBlock = Array.from(el.children).find(
            (c) => BLOCK_TAGS.has(c.tagName) && wordCount((c.innerText ?? "").trim()) >= floor,
          );
          if (!nestedBlock) return { el, text };
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  // Every block that could join a selection, in document order. Word counts use
  // textContent because this scans the whole page and innerText reflows.
  function leafBlocks(root, floor) {
    const out = [];
    for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
      if (wordCount(el.textContent ?? "") < floor) continue;
      const nested = Array.from(el.children).some(
        (c) => BLOCK_TAGS.has(c.tagName) && wordCount(c.textContent ?? "") >= floor,
      );
      if (nested) continue;
      if (el.closest(SKIP_CLOSEST)) continue;
      if (!isVisible(el)) continue;
      out.push(el);
    }
    return out;
  }

  // ---------- targets ----------
  //
  // A target is one or more blocks judged as a single piece of text. Hover makes
  // single-block ones; clicking, dragging and double-clicking make wider ones.

  function makeTarget(els) {
    const text = els
      .map((el) => (el.innerText ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    return { els, text, sent: clampText(text) };
  }

  // The leading `n` words, cut on a word boundary and keeping the original
  // spacing — the blank lines between blocks are what tell the model where one
  // ends and the next begins, so re-joining split words would lose that.
  function firstWords(text, n) {
    const word = /\S+/g;
    let seen = 0;
    let match;
    while ((match = word.exec(text))) {
      if (++seen === n) return text.slice(0, match.index + match[0].length);
    }
    return text;
  }

  // What we are willing to send: the user's word budget, then the model's state
  // budget as a backstop. Trimming beats refusing — a verdict on the first part
  // of a long selection is more use than an error, as long as the card says so.
  function clampText(text) {
    const budgeted = wordCount(text) > maxWords ? firstWords(text, maxWords) : text;
    const maxChars = MAX_STATE_TOKENS * CHARS_PER_TOKEN;
    if (budgeted.length <= maxChars) return budgeted;
    const cut = budgeted.slice(0, maxChars);
    const boundary = cut.lastIndexOf(" ");
    return boundary > 0 ? cut.slice(0, boundary) : cut;
  }

  function unionRect(els) {
    const rects = els.map((el) => el.getBoundingClientRect());
    return {
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
    };
  }

  function sameTarget(a, b) {
    return a && b && a.els.length === b.els.length && a.els.every((el, i) => b.els[i] === el);
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

  function positionCard(target) {
    const c = ensureCard();
    const rect = unionRect(target.els);
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

  // A single paragraph is obvious from the outline; a multi-block selection is
  // not, so say how much text the verdict covers — and never let a trim pass
  // unmentioned, or the answer would look like it covered the whole selection.
  function appendScope(c, target) {
    const words = wordCount(target.text);
    const sent = wordCount(target.sent);
    if (target.els.length < 2 && sent === words) return;

    const note = document.createElement("div");
    note.className = "sniffslop-scope";
    note.textContent = `${target.els.length} block${target.els.length > 1 ? "s" : ""} · ${words} words`;
    if (sent < words) note.textContent += ` · judged on the first ${sent}`;
    c.appendChild(note);
  }

  function renderPending(target) {
    const c = ensureCard();
    c.innerHTML = `<div class="sniffslop-row"><span class="sniffslop-spinner"></span><span>Sniffing…</span></div>`;
    appendScope(c, target);
    positionCard(target);
  }

  function renderError(target, message) {
    const c = ensureCard();
    c.innerHTML = `<div class="sniffslop-err"></div>`;
    c.querySelector(".sniffslop-err").textContent = message;
    positionCard(target);
  }

  function renderResult(target, result) {
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
    appendScope(c, target);
    positionCard(target);
  }

  function hideCard() {
    if (card) card.style.display = "none";
  }

  function paintTarget(target, classes, color) {
    for (const el of target.els) {
      el.classList.add(...classes);
      if (color) el.style.setProperty("--sniffslop-color", color);
    }
  }

  function unpaintTarget(target) {
    if (!target) return;
    for (const el of target.els) {
      el.classList.remove("sniffslop-hl", "sniffslop-hl-pending", "sniffslop-pick");
      el.style.removeProperty("--sniffslop-color");
    }
  }

  function clearHighlight() {
    unpaintTarget(current);
    current = null;
  }

  function clearPicked() {
    unpaintTarget(picked);
    picked = null;
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

  function paintDone(target, entry) {
    for (const el of target.els) el.classList.remove("sniffslop-hl-pending");
    if (entry.state === "error") {
      paintTarget(target, [], "#9aa0a6");
      renderError(target, entry.error);
      return;
    }
    // Never let a render fault leave the card hidden — that reads as "no result"
    // and hides the actual cause.
    try {
      const items = entry.result?.items;
      if (!Array.isArray(items) || !items.length) {
        throw new Error(`no items in response: ${JSON.stringify(entry.result).slice(0, 120)}`);
      }
      paintTarget(target, [], outlineColor(items));
      renderResult(target, entry.result);
    } catch (err) {
      console.error("[SniffSlop] render failed", err, entry.result);
      paintTarget(target, [], "#9aa0a6");
      renderError(target, `Render error: ${err?.message ?? err}`);
    }
  }

  // Is this target still the one the user is looking at? An answer that arrives
  // after the cursor or the selection moved on must not repaint stale blocks.
  function isLive(target) {
    return armed && (sameTarget(picked, target) || (!picked && sameTarget(current, target)));
  }

  async function requestScore(target) {
    // The minimum applies to the selection as a whole: pinning several short or
    // fragmented paragraphs is how you get past it.
    const words = wordCount(target.text);
    if (words < minWords) {
      renderError(target, `Only ${words} words — below the ${minWords}-word minimum.`);
      return;
    }

    const key = hashText(target.sent);
    const cached = cache.get(key);

    if (cached?.state === "done" || cached?.state === "error") {
      paintDone(target, cached);
      return;
    }
    if (cached?.state === "pending") {
      renderPending(target);
      return;
    }

    cache.set(key, { state: "pending" });
    renderPending(target);

    let entry;
    try {
      const res = await api.runtime.sendMessage({ type: "score", text: target.sent });
      entry = res?.ok
        ? { state: "done", result: res.result }
        : { state: "error", error: res?.error ?? "Request failed." };
    } catch (err) {
      entry = { state: "error", error: String(err?.message ?? err) };
    }
    cache.set(key, entry);

    if (isLive(target)) paintDone(target, entry);
  }

  // ---------- events ----------

  function considerTarget(node) {
    if (!armed) return;
    // A picked selection owns the card until it is cleared, so hovering past it
    // must not quietly replace the verdict the user asked for. Still mark what
    // the cursor is over — without it the blocks you could add to the selection
    // look as inert as the rest of the page.
    if (picked) {
      showCandidate(node);
      return;
    }

    const block = findBlock(node);

    if (!block) {
      clearTimeout(dwellTimer);
      clearHighlight();
      hideCard();
      return;
    }
    if (current?.els[0] === block.el) return;

    clearTimeout(dwellTimer);
    clearHighlight();

    current = makeTarget([block.el]);
    paintTarget(current, ["sniffslop-hl"]);

    const cached = cache.get(hashText(current.text));
    if (cached?.state === "done" || cached?.state === "error") {
      paintDone(current, cached); // cached: instant, no dwell, no request
      return;
    }

    paintTarget(current, ["sniffslop-hl-pending"]);
    const target = current;
    dwellTimer = setTimeout(() => requestScore(target), DWELL_MS);
  }

  // ---------- picking: click, drag, double-click ----------

  // The block the cursor is over while a selection is pinned: a dashed hint
  // saying "click to add this one". Blocks already in the selection get nothing
  // extra — they are outlined already.
  let candidate = null;

  function showCandidate(node) {
    const el = findBlock(node, PICK_MIN_WORDS)?.el ?? null;
    const wanted = el && !picked.els.includes(el) ? el : null;
    if (wanted === candidate) return;
    clearCandidate();
    candidate = wanted;
    if (candidate) candidate.classList.add("sniffslop-cand");
  }

  function clearCandidate() {
    if (candidate) candidate.classList.remove("sniffslop-cand");
    candidate = null;
  }

  function pick(els) {
    clearTimeout(dwellTimer);
    clearHighlight();
    clearCandidate();
    clearPicked();
    if (!els.length) {
      hideCard();
      return;
    }
    picked = makeTarget(els);
    paintTarget(picked, ["sniffslop-hl", "sniffslop-pick", "sniffslop-hl-pending"]);
    requestScore(picked);
  }

  // Click toggles a block in and out of the picked set and re-scores the rest,
  // so the card always describes exactly what is outlined.
  function togglePick(el) {
    const held = picked?.els ?? [];
    const next = held.includes(el) ? held.filter((e) => e !== el) : [...held, el];
    pick(inDocumentOrder(next));
  }

  function inDocumentOrder(els) {
    return [...els].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
  }

  // Everything a reader-mode view would keep, in reading order.
  function readerBlocks() {
    const root = document.querySelector(READER_ROOTS) ?? document.body;
    return leafBlocks(root, READER_MIN_WORDS);
  }

  let drag = null; // { anchor, blocks, moved }

  function onMouseDown(event) {
    if (!armed || event.button !== 0) return;
    // Suppress the native text selection and any link drag: while armed the
    // pointer belongs to us.
    event.preventDefault();

    const block = findBlock(event.target, PICK_MIN_WORDS);
    if (!block) {
      drag = null;
      return;
    }
    drag = { anchor: block.el, blocks: null, moved: false };
  }

  // Drag extends over the run of blocks between the anchor and the pointer, in
  // either direction — the block list is built once per drag, not per move.
  function onDragOver(node) {
    const block = findBlock(node, PICK_MIN_WORDS);
    if (!block || block.el === drag.anchor) return;

    drag.blocks = drag.blocks ?? leafBlocks(document.body, PICK_MIN_WORDS);
    const from = drag.blocks.indexOf(drag.anchor);
    const to = drag.blocks.indexOf(block.el);
    if (from < 0 || to < 0) return;

    drag.moved = true;
    drag.run = drag.blocks.slice(Math.min(from, to), Math.max(from, to) + 1);
    clearHighlight();
    clearCandidate();
    clearPicked();
    picked = makeTarget(drag.run);
    paintTarget(picked, ["sniffslop-hl", "sniffslop-pick"]);
    hideCard(); // the verdict comes on release, not mid-drag
  }

  function onMouseUp(event) {
    if (!armed || event.button !== 0 || !drag) return;
    const dragged = drag.moved ? drag.run : null;
    drag = null;

    if (dragged) pick(dragged);
  }

  let clickTimer = null;

  function onClick(event) {
    if (!armed) return;
    // Armed clicks are gestures, not page interactions — don't follow links.
    event.preventDefault();
    event.stopPropagation();
    if (event.detail > 1) return; // the dblclick handler owns this one

    const block = findBlock(event.target, PICK_MIN_WORDS);
    // Can't act yet: a second click within DBLCLICK_MS means the user meant
    // "the whole page", and pinning first would fire a request we'd throw away.
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (block) togglePick(block.el);
      else pick([]); // a click off any block clears the selection
    }, DBLCLICK_MS);
  }

  function onDblClick(event) {
    if (!armed) return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(clickTimer);
    pick(readerBlocks());
  }

  function onMouseOver(event) {
    if (!armed) return;
    if (drag) onDragOver(event.target);
    else considerTarget(event.target);
  }

  // Re-evaluate whatever is under the cursor right now, without waiting for the
  // pointer to move.
  function probeCursor() {
    if (!havePoint) return;
    const target = document.elementFromPoint(lastX, lastY);
    if (target) considerTarget(target);
  }

  // Escape backs out one level: first it drops the selection, and only an
  // Escape with nothing selected turns the extension off.
  function onKeyDown(event) {
    if (event.key !== "Escape" || !armed) return;
    if (picked) {
      clearTimeout(clickTimer);
      pick([]);
      probeCursor(); // hand the cursor's own block back to hover
      return;
    }
    disarm();
  }

  function onScrollOrResize() {
    const shown = picked ?? current;
    if (armed && shown && card?.style.display === "block") positionCard(shown);
  }

  const GESTURES = [
    ["mouseover", onMouseOver],
    ["mousedown", onMouseDown],
    ["mouseup", onMouseUp],
    ["click", onClick],
    ["dblclick", onDblClick],
    ["keydown", onKeyDown],
  ];

  async function arm() {
    const res = await api.runtime.sendMessage({ type: "settings" });
    if (res?.ok) {
      minWords = Number(res.settings.minWords) || 25;
      maxWords = Number(res.settings.maxWords) || 20000;
    }
    armed = true;
    for (const [type, handler] of GESTURES) document.addEventListener(type, handler, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    showToast("SniffSlop on — hover a block, click to pin, drag to span, double-click for the page");
    probeCursor(); // the cursor is probably already over something
  }

  function disarm() {
    armed = false;
    clearTimeout(dwellTimer);
    clearTimeout(clickTimer);
    drag = null;
    clearHighlight();
    clearCandidate();
    clearPicked();
    hideCard();
    for (const [type, handler] of GESTURES) document.removeEventListener(type, handler, true);
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
    const relevant = ["questions", "model", "apiKey", "minWords", "maxWords"].some((k) => k in changes);
    if (!relevant) return;

    cache.clear();
    if ("minWords" in changes) minWords = Number(changes.minWords.newValue) || 25;
    if ("maxWords" in changes) maxWords = Number(changes.maxWords.newValue) || 20000;
    if (!armed) return;

    clearTimeout(dwellTimer);
    if (picked) {
      // A new budget means a new clamp, so rebuild the target before re-asking.
      picked = makeTarget(picked.els);
      requestScore(picked);
      return;
    }
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
