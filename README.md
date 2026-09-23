# SniffSlop

Hover a paragraph, find out how likely it is written by AI, or define whatever questions you want to ask with
[Jev](https://docs.typesafe.ai/).

[demo.webm](https://github.com/user-attachments/assets/384f5afd-7826-4da4-bb4e-33138787a391)

## Install

No build step — it's plain JS, load the folder as-is.

**Chrome**

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder

**Firefox**

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `manifest.json` inside this folder

Temporary add-ons are cleared when Firefox restarts; a permanent install needs a
signed build.

## API key

Obtain your Jev API key at [typesafe console](https://console.typesafe.ai/keys).
Paste your API key into the extension by clicking the extension toolbar icon and hit **Save**. 
Use it at your own risk.

The key is stored with `storage.local`, which keeps it on this machine and this
browser profile — it is not browser-synced, so it does not travel to your other
devices. Nothing is collected by me, no telemetry, no analytics, and no
server belonging to this extension. The only host it can reach at all is
`api.typesafe.ai`, because that is the sole entry in `host_permissions`; any
request anywhere else would be blocked by the browser.

The key is read only by the background script, which attaches it as a
`Authorization: Bearer` header on calls to TypeSafe. The content script running
inside web pages never sees it — it hands text to the background script and gets
an answer back, so page JavaScript has no path to it.

## Use

1. Add your API key as above.
2. Press the shortcut (default `Cmd+Shift+X` / `Ctrl+Shift+X`) to arm sniff mode on a page.
3. Hover any block of text with 25+ words. It outlines grey while the request is
   in flight, then turns green → amber → red and shows a card with one section
   per configured question.

   The outline colour comes from the first question that maps onto a scale —
   a `score` (position across its levels) or a `noul` (its probability). Choice
   answers have no inherent ordering, so if every question is a `choice` the
   outline stays neutral blue and the card carries the detail.

   **Hue is the answer, saturation is the certainty.** An uncertain answer looks
   washed out instead of confidently green or red. Confidence gets no row of its
   own: it is computed from the probability distribution the card already draws,
   so showing it would restate the bars. Nouls have no confidence field, so
   certainty is derived from the distance to 0.5.
4. Shortcut again or `Esc` to disarm.

Results are cached per page by text hash, so re-hovering a block you already
scored is instant and costs nothing until you reload. Saving anything in the
popup clears that cache — answers are only valid for the settings that produced
them — and immediately re-scores whatever is under the cursor.

## Settings

- **Questions** — any number, all three primitives. Every hover sends them in a
  single request: the API scores each question independently against the same
  document, and the document is only transmitted once, so N questions cost far
  less than N calls.

  | type | criteria | answer |
  |---|---|---|
  | `score` | ordered array, low → high, 2–10 levels | `score` (weighted position across levels) + `confidence` + `probabilities` |
  | `choice` | object of `option_name` → description | `choice` + `confidence` + `probabilities` |
  | `noul` | optional `true`/`false` descriptions | `noul`, a single 0–1 probability of yes |

  The default is one `score` question: `How likely is this text AI slop`, with
  levels `Likely human` / `50/50 slop` / `AI Slop`. A score of 1.43 there means
  "leaning slop".

- **Minimum words per block** — default 25, raise it to ignore short blurbs.
- **Shortcut** — on Firefox, **Change** records a new binding directly in the
  popup (`commands.update()`). Chrome has no equivalent API, so there the button
  opens `chrome://extensions/shortcuts` instead. Either way the browser can
  refuse a combination it reserves for itself.

## Define your own questions

Slop detection is just the default. The question is whatever you want to ask
of a paragraph, and you can stack several — they cost one request between
them. Open the popup, hit **+ Add question**, pick a type, and write the
instructions.

Pick the type by the shape of the answer you want:

- **`noul`** for a yes/no — *"Does this cite a source?"*, *"Is this a sales
  pitch?"*. You get one number: the probability of yes. Criteria are optional;
  add them when "yes" needs pinning down.
- **`score`** for a spectrum — *"How technical is this?"* with levels
  `Layperson` → `Practitioner` → `Specialist`. Write the levels in order, low
  to high. The answer is a weighted position across them, so it lands between
  levels rather than snapping to one.
- **`choice`** for named buckets with no ordering — *"What is this paragraph
  doing?"* with options `argument`, `evidence`, `anecdote`, `filler`. Give
  each option a description saying when to pick it; that description does most
  of the work.

A few things that make answers better:

- **Describe the levels, don't just name them.** `Broken, but a workaround
  exists` beats `Medium`. The model reads the descriptions.
- **Order matters for `score`, not for `choice`.** Score levels must run low
  to high; choice options are unordered, which is why a choice answer leaves
  the outline neutral.
- **Ask one thing per question.** A level that mixes two dimensions produces a
  flat distribution — the answer washes out, which shows up as a desaturated
  outline.
- **The question id is the key in the API request**, so it gets slugified on
  save: `Is it technical?` becomes `is_it_technical`.

Changing a question's type converts its criteria to the new shape, because
sending an array where the API expects an object is a 422.
