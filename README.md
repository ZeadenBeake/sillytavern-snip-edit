# sillytavern-snip-edit

A SillyTavern extension for inline, selection-based AI editing of chat messages — the
"highlight text → describe an edit → get it rewritten in place" workflow, similar to
inline-edit features in code editors, but for your chat.

## What it does

1. Highlight any text inside a chat message (yours or the character's).
2. A small **Edit** button appears next to the selection.
3. Click it, type an instruction (e.g. "make this more formal", "fix the typo", "shorten
   this"), and confirm.
4. The extension sends the selected text (plus a bit of surrounding context, if enabled)
   to a one-off generation call against **whichever API/backend you currently have
   selected** in SillyTavern (KoboldAI, text-completion, chat-completion, etc. — it reuses
   your main connection, not a hardcoded one).
5. The model's rewritten text replaces the original selection in the message, and the
   chat is saved.

A "click to undo" toast appears after each edit, reverting the single most recent change.

## Installation

Pick one:

**A. Install from this repo's URL (recommended)**
In SillyTavern, open the **Extensions** panel → **Install extension**, paste:
```
https://github.com/ZeadenBeake/sillytavern-snip-edit
```
and choose "install for me" or "install for all users" (admin only).

**B. Manual copy**
Copy this whole repo's contents into one of:
- `data/<your-user-handle>/extensions/sillytavern-snip-edit/` (just for your user), or
- `public/scripts/extensions/third-party/sillytavern-snip-edit/` (all users on this install)

Then reload SillyTavern. You should see "Inline AI Edit" listed and enabled under
Extensions.

## Settings

Under the Extensions panel, open the **Inline AI Edit** drawer:
- **Enable inline AI edit** — turn the feature on/off without uninstalling.
- **Context characters** — how many characters of surrounding raw message text to send
  along as background context (not edited, just for the model's understanding). Set to
  `0` to send only the selected snippet.

## Known limitations

- **Plain text works best.** The button operates on the *rendered* text you see on
  screen, but the edit is applied to the *raw* message source (markdown + macros like
  `{{user}}`/`{{char}}`). For ordinary prose these match exactly. If your selection falls
  across markdown formatting (`**bold**`, headers, links) or a macro, the extension may
  not find an exact match in the raw text and will warn instead of guessing wrong.
- **Repeated snippets.** If the exact selected text appears more than once in the
  message, the extension picks the occurrence closest to where you actually selected it
  (via rendered-text offset), which is usually right but isn't guaranteed.
- **Single-level undo.** Only the most recent edit can be undone via the toast.
- Selection must be fully contained within one message; cross-message selections are
  ignored.

## Files

- `manifest.json` — extension metadata SillyTavern reads to load it.
- `index.js` — all logic (selection detection, popup, generation call, message patch).
- `style.css` — styling for the floating toolbar and popup preview.

## License

[The Unlicense](LICENSE) — public domain.
