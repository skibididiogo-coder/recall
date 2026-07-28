# Recall

A study app: import your material, turn it into flashcards, and review them on a spaced-repetition
schedule so you revise things right before you'd forget them.

Built as a single static page — no framework, no build step, no bundler. Open `index.html` and it
runs.

## What it does

- **Import** a PDF or paste text, or build decks by hand
- **AI flashcards and summaries** generated from that material
- **SM-2 spaced repetition**, plus quiz and cram modes
- **Study artifacts** grounded in your material: comparison tables, pre-exam summary sheets,
  concept maps, timelines, and charts — all hand-rolled SVG, all exportable
- **Per-deck chat** that answers only from the material you imported
- **Read-aloud**, using pre-generated [Kokoro](https://github.com/hexgrad/kokoro) clips rather than
  the browser's own voice — `af_heart` for English, `pf_dora` for Portuguese
- **Home dashboard** with what's due, per-deck mastery, an activity heatmap, and a weak-spot list

## Running it

Open `index.html` in Chrome. That's it.

To serve it over HTTP instead (needed if you want a real origin rather than `file://`):

```bash
python3 -m http.server 8899
# then open http://localhost:8899
```

## The API key

AI features call the Anthropic API **directly from your browser**, using a key you enter yourself.
The key is stored in your own browser's `localStorage` and is sent to `api.anthropic.com` and
nowhere else. It is not in this repository and never touches a server.

If you don't provide a key, everything that doesn't need AI still works — manual decks, review,
quiz, cram, progress.

## Where your data lives

**In `localStorage`, in the browser, on the device you're using.** That has two consequences worth
knowing before you rely on it:

1. **Clearing your browser data deletes everything.** Use the export button. Really.
2. **`localStorage` is scoped per origin.** Opening the app at a different address — `file://`
   versus `http://localhost` versus a hosted URL — gives you a *different, empty* library. Nothing
   is lost, but it will look like it is. Move your decks across with export → import.

The importer refuses empty and malformed backup files, so a truncated export can't quietly
overwrite a good library.

## Audio

The clips in `audio/` are pre-generated. `audio/clips.js` lists which ones exist, so the app knows
what it can play without a `fetch()`. Filenames are content hashes — edit a card and its old clip
stops being used automatically.

Regenerating them needs the Kokoro toolchain, which lives outside this repository.
