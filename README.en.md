# anti-slop

[![SillyTavern extension](https://img.shields.io/badge/SillyTavern-extension-blue)](https://github.com/SillyTavern/SillyTavern)
[![changelog](https://img.shields.io/badge/changelog-versions-informational)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Русский](README.md) · **English**

**An extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern)** that reads the model's
replies in your chat and shows which phrases it keeps repeating. Not guesses — numbers: how many
times, in which messages, more often or less than before.

Everyone knows the feeling when a chill runs down someone's spine for the hundredth time and you no
longer remember when it started. Now you do.

Everything is counted in your browser: **no requests to the model, no bytes leaving the page**. The
only feature that spends tokens is the prompt rule, and it is off by default.

## In short

- 📊 **Repetition index 0–100** plus a second tile for the last 20 replies — you see not just "bad"
  but "getting worse right now".
- 🔁 **List of repeated phrases**: how many times, which messages, a button to jump there.
- 📉 **"Rarer", "more often" and "gone quiet"** marks — the phrase's pace before and after a chosen
  point.
- 🙈 **Hide a phrase** you are fine with; hidden phrases survive a reload.
- 📈 **Per-message chart** and an index badge on every reply in the chat.
- 🪞 **Self-repetition**: which message retells an earlier one, and whether there are verbatim runs.
- ✍️ **A repetition rule for the prompt** — not a bare ban list, but what to write instead (off by
  default).
- 📤 **Export**: the rule, the list, JSON for ProsePolisher, a PNG summary card.
- 🧵 **Counting in a worker** — on a 166k-word chat the SillyTavern UI does not stutter.
- 💾 **Numbers survive a reload** and come back the moment you open the chat.
- 🌍 Russian and English, both in the UI and in the analysed text, with stemming.

## Requirements

SillyTavern only. Tested on 1.18.0. No API keys, no companion extensions, no internet.

## Install

### Option 1 — from SillyTavern

Extensions → **Install extension** → paste the link:

```
https://github.com/aika636/anti-slop
```

### Option 2 — manually

Download the repository and put the folder into
`public/scripts/extensions/third-party/anti-slop`.

**The extension is the whole folder, not a subfolder inside it.**

## Usage

The panel lives in Extensions, section **anti-slop**.

1. Open a chat and press **"Analyse this chat"**. On a chat of about fifty replies this takes roughly
   a second.
2. Read the tiles, the chart and the phrase list. Clicking a phrase or a bar jumps to the message.
3. A phrase you are fine with goes away with "don't count this phrase" — into a separate list you can
   always restore from.

After that you can leave the button alone: new replies are added on the fly. The button is only for
the cases where they cannot be — a chat opened for the first time, or numbers gone stale after an
edit, a swipe or a deletion. Turn on "count on its own" and the extension handles those too.

## The prompt rule

The extension can add a block like this to the request:

```
<repetition>
Before you write, check what you are about to say against the list below. Replace
any phrase from the list that wants into your reply: say the same thing through a
concrete action, a detail of the setting or a bodily sensation instead of a ready
formula.
These are not forbidden words — they are the spots where this chat has worn thin.
Worn-out phrases (8): ...
</repetition>
```

Why a rule and not a ban list: naming a phrase is how you remind the model of it. A rule says what to
write instead. A bare list is available too, as a separate mode for people who know why they want it.

**About the effect.** The extension is good at *finding* repetition. How much the rule *reduces* it
depends on the model: in our measurements a reasoning model roughly halved its repetition, while a
model without a reasoning block did not. That is why the rule is off by
default, and why the panel shows "rule hit rate" next to it — how many listed phrases actually
appeared in recent replies. If almost none do, the rule is spending tokens for nothing, and you will
see it.

For the same reason the "rarer" and "gone quiet" marks are worded as observations, not as the
extension's merit: a phrase also fades simply because the scene changed.

## Limitations

- **Edits, swipes and deletions cannot be added incrementally** — the counter only accumulates. The
  extension says the numbers are stale and waits for a recount.
- **Below 50k words the index is marked as draft.** On a short chat repetition has nowhere to come
  from, and a low index says more about length than about quality.
- **The index is a relative measure, not an absolute grade.** Its job is not to confuse obviously
  different texts, and to stay comparable within one chat — not to score prose on a universal
  scale.
- **Word stems are never shown** — neither to you nor to the model.

## Privacy

All counting happens in your browser. No requests to the model, no bytes leaving the page, no LLM
inside. Results live in your browser's IndexedDB, settings in SillyTavern's settings.

The one exception is the prompt rule when you switch it on: the phrase list then travels to the same
model as the chat, inside the usual request.

## Development

Module layout, benchmarks and everything worth remembering before touching this code are in
[DEVELOPMENT.md](DEVELOPMENT.md) (in Russian).

```
npm test
```

No dependencies: the tests run on plain `node --test`.

The performance bench opens straight from a browser, phones included, and sends nothing anywhere:
**<https://aika636.github.io/anti-slop/tools/bench/index.html>**

## Credits

The idea of giving the model a replacement rule instead of a ban list came from preset authors'
practice, not from theory. The `{{slopList}}` interchange format is borrowed from ProsePolisher.

## License

MIT — see [LICENSE](LICENSE).
