# clear-unused-assets

**English** | [简体中文](./README.zh-CN.md)

Pasted screenshots, clipped images and one-off diagrams pile up in a vault long after the notes that referenced them are gone. This plugin finds attachment files that no note references any more and deletes them — after showing you exactly what it found, with a checkbox per file so you can keep any of them.

This plugin is inspired by oz-clear-unused-images-obsidian. It was developed to address a few problems left unsolved by its predecessor:
1. oz-clear-unused-images-obsidian has not been updated in a long time, and its issues go unattended
2. oz-clear-unused-images-obsidian does not recognize links inside HTML references, so it mistakenly deletes attachments
3. oz-clear-unused-images-obsidian deletes attachments with no second chance to choose — users sometimes have no idea which attachments were removed, and cannot remove them selectively

In response, this plugin's **most important addition** is a confirmation list that lets you pick by hand what gets deleted and what stays.

This plugin was developed entirely by Claude Opus 5.

- **Minimum Obsidian version**: 1.4.0
- **Platforms**: Desktop only
- **UI languages**: Simplified Chinese / English
- **License**: MIT

---

## ✨ How it decides

The whole design follows from one asymmetry: **a missed reference deletes a file you still need, while a spurious reference merely keeps a file you wanted gone.** Everything below errs in the second direction.

- 🔎 **Whole-vault reference scan**: excluding a folder narrows only what may be *deleted*; references are always collected from the entire vault, otherwise an attachment used by a note outside the target folder would look unused
- 🧩 **Two passes, unioned**: Obsidian's `metadataCache` (wikilinks, Markdown links, embeds, frontmatter links, canvas nodes) **plus** a raw-text sweep of every text-ish file, because the cache does not see `<img src>`, CSS `url()`, `srcset`, `[ref]:` definitions, bare frontmatter paths, YAML list items, or `.base` view config. The sweep ends with a catch-all for any token that looks like a filename — enumerating the shapes people actually use is a losing game when the cost of missing one is a deleted file
- 🛑 **Fails closed**: a file the scan cannot read or parse aborts the run and names that file. That includes malformed canvas JSON and Excalidraw drawings stored as compressed JSON, whose image references no parser can see
- 🚨 **Tripwire**: if 90% or more of the in-scope attachments look unreferenced (and there are at least 10 of them), the run aborts instead of offering to empty your attachment folder — that pattern is what a cold index looks like, not a dirty vault
- ⏳ **Waits for the index**: both entry points refuse until Obsidian reports link resolution complete
- ⚠️ **Flags what it is unsure about**: candidates with a duplicate basename, or whose name appears in Obsidian's unresolved links, or that were only seen as a broken text reference, are listed **unticked** so keeping them is the default
- 🔁 **Re-verifies before deleting**: the confirmation dialog can sit open for minutes, so the reference scan runs again at delete time. Anything that became referenced, or that moved, is kept and reported
- 🗂️ **Documents are never attachments**: `md`, `canvas` and `base` are ignored even if you list them — being unreferenced is a normal state for a note
- 🈯 **Bilingual UI**: switch between Chinese/English in settings; the command name and ribbon tooltip refresh in place
- 🧷 **Config safety**: `data.json` carries a `version` field; an unreadable file leaves the plugin loaded but paused, with a repair button on the settings page that backs the old file up first

---

## 🚀 Installation

**Manual install (only supported method for now)**

```
<Your Vault>/.obsidian/plugins/clear-unused-assets/
├── main.js
└── manifest.json
```

1. Create the directory `.obsidian/plugins/clear-unused-assets/` inside your vault
2. Run `npm install` in the repo root
3. Edit `TARGET_DIR` at the top of `build.sh` to point at the directory above, then run `./build.sh` — it bundles via esbuild and copies `main.js` / `manifest.json` for you
4. Enable the plugin in Obsidian

---

## 🖱️ Triggering

Both entry points run the same thing:

- Click the Ribbon icon on the left (`image-file`)
- Command palette → `Clear unused assets` / `清理未被引用的附件`

A run reports through a Notice. The full list of deleted, kept and failed paths goes to the developer console, so there is a record of a destructive operation without a wall of text in the corner of the screen.

---

## ⚙️ Settings

Path: `Settings → Community plugins → clear-unused-assets`

### Language / 语言

| Value | Description |
|---|---|
| `zh-CN` (default) | Chinese UI, command name "清理未被引用的附件" |
| `en` | English UI, command name "Clear unused assets" |

Switching updates the command palette entry and Ribbon tooltip live (internally re-registers via `removeCommand` + `addCommand`).

### Scope

| Setting | Default | Meaning |
|---|---|---|
| Folders to clean | *(empty)* | Vault-relative paths, one per line. Empty means the whole vault. Subfolders included. |
| Folders to exclude | *(empty)* | Vault-relative paths, one per line. Empty excludes nothing. Subfolders excluded too. **Only narrows what may be deleted.** |
| Extensions to clean | `png,jpg,jpeg,gif,bmp,svg,webp,avif` | Comma-separated, case-insensitive, a leading dot is fine. |

Both folder lists are validated equally strictly, and a problem in either **stops the run** rather than warning:

- an absolute path (`/assets`, `C:\pics`, `~/pics`, `\\server\share`) or one containing `..` is rejected — on **every** line, including a duplicate spelling of a folder already accepted
- a path that does not exist, or that names a file rather than a folder, is rejected
- a target folder lying entirely inside an excluded folder is reported as a contradiction instead of silently producing no candidates
- an extension token that cannot be a file extension (`png jpg`, `PNG;JPG`) is rejected rather than kept, so a mis-typed separator reports an empty list instead of silently matching nothing

A typo in *exclude* is treated as seriously as one in *clean* on purpose: a mistyped target folder merely finds nothing, but a mistyped exclusion silently removes protection you explicitly asked for.

Validation results appear inline next to the fields, not as a Notice per keystroke. Text fields persist on a ~500 ms debounce and are flushed when you leave the settings page.

### Deletion

| Setting | Default | Meaning |
|---|---|---|
| Deleted file destination | Move to Obsidian trash (`.trash`) | `Follow the Obsidian setting` (`FileManager.trashFile`), `.trash`, system trash, or permanent |
| Confirm before deleting | on | Lists candidates with a checkbox each |

Choosing **Delete permanently** forces confirmation back on and locks the toggle. Permanent deletion has no undo, and every gap in reference detection becomes unrecoverable loss the moment it runs unattended — especially on a synced vault, where a device that has not yet received a note cannot know that note references a file.

### Reset

Restores every setting to its default and writes `data.json` immediately. Queued text edits are discarded so a debounced save cannot resurrect a value the reset just cleared.

---

## 🗃️ `data.json` and the `version` field

The settings file carries `"version": 1`. The policy is deliberately strict — a settings file this plugin does not understand is never guessed at:

**On read**

| On-disk `version` | Behaviour |
|---|---|
| missing / non-integer / `< 1` | Error: illegal field. The plugin still loads. |
| `> 1` | Error: the file is newer than the plugin. The plugin still loads. |
| `1` | Normal. Individual invalid fields fall back to their defaults; keys this version does not know are kept as-is. |
| file present but unparseable | Error: corrupt. **Never** mistaken for a fresh install, so your bytes are not overwritten. |
| file absent (fresh install) | Defaults are written. Not an error. |

A failed read leaves the plugin **loaded but paused**: a Notice states the reason, both entry points refuse to run, and the settings page renders every control plus a **Repair settings file** button. Whatever fields were readable are kept, so repairing preserves your configuration rather than resetting it.

**On write**

Every write re-reads the file first, and all writes are serialized in a queue so the read-decide-write cycle cannot interleave:

| On-disk `version` | Behaviour |
|---|---|
| missing / invalid / `< 1` | Copy it to `data.<timestamp>.json.bak`, then write a fresh valid file. |
| `> 1` | Refuse to write, and say so. |
| `1` | Write, merging over the existing file so unknown keys survive. |

A backup is also taken whenever a write happens while the config is in the broken state, even if the file on disk parses cleanly — in that state the in-memory values are a reconstruction, and the bytes on disk may be the only copy of the real settings.

Backups are timestamped and never overwrite an existing one, so a second bad write cannot destroy the first backup.

The one exception to the refuse-to-write rule is the explicit **Repair settings file** button: refusing an automatic write protects a newer sibling install's config, but refusing an explicit repair would leave no in-app way out.

Adding a new setting does **not** bump the version — only a change old code genuinely cannot read does.

---

## 🏗️ Project layout

```
src/main.js          plugin lifecycle: command, ribbon icon, settings tab, the run pipeline
src/settings.js      the i18n table, data.json persistence, settings page
src/scope.js         scope validation: which folders and extensions a run may touch
src/clear.js         the scan + delete engine
src/confirmWindow.js the per-file checkbox confirmation dialog
ut/                  node:test unit tests; ut/helpers/bootstrap.js stubs `require("obsidian")`
```

Responsibilities do not overlap: `settings.js` never scans, `scope.js` knows nothing about strings or persistence, `clear.js` never raises a Notice or touches the DOM, and `main.js` is the only place that wires them together and talks to the user.

`resolveScope()` lives in `scope.js` and is called by both the settings page and the run entry point, so the page can never call a configuration valid that a run would then refuse.

```bash
npm install
npm test        # node --test ut/*.test.js
npm run check   # bundle with esbuild, then syntax-check the output
```

### Cost

On a synthetic 20 000-file vault (16 000 notes at ~2 KB, 4 000 attachments) a full scan takes roughly **2.5 seconds** and the delete-time re-verification about the same, with the heap under 60 MB. Both loops yield to the UI every 50 files, so Obsidian stays responsive.

The sweep's catch-all pattern is anchored on a left delimiter so it stays linear. An earlier unanchored version re-scanned every start offset inside one long delimiter-free run — an inline base64 data URI, which every uncompressed Excalidraw scene contains — and took 4.9 s on 80 KB and 20 s on 160 KB, all of it blocking the UI thread.

---

## 🔍 Known limits of reference detection

**What is covered.** Obsidian's `metadataCache` supplies wikilinks, Markdown links, embeds, frontmatter links and (on 1.12+) canvas nodes. On top of that, the raw-text sweep reads **every file that is not a known binary format** — not just a fixed list of text extensions, because an unfamiliar extension may be a user script, a config file, or a format that did not exist when the list was written, and each of those can hold the only reference to an attachment. A file that turns out to contain NUL bytes is skipped as binary after all.

The sweep catches `<img src>` with or without quotes, `xlink:href`, `data`, `poster`, `srcset`, CSS `url()` and `image-set()`, reference-style definitions (`[ref]: path`), footnote bodies, table cells, callouts, bare frontmatter paths, YAML list items, `.base` view config, canvas `file` and `group.background` keys, Windows-style backslash paths, percent-encoded names, filenames containing `#`/`?`/`|`, filenames containing spaces (including Obsidian's own `Pasted image …png` default), and any remaining delimiter-bounded token ending in a file extension.

**What aborts the run instead of guessing.** Unreadable files, malformed canvas JSON, and Excalidraw drawings saved with "Compress Excalidraw JSON in Markdown" enabled — the embedded-image wikilinks in a compressed drawing are not present as text, so no parser can see them. Disable compression, or add that attachment folder to the exclusions.

**Deliberately over-eager.** A link inside a fenced code block or a `%%comment%%` does not create a backlink in Obsidian, but the sweep still counts it, so the file is kept. That is intentional: erring toward keeping costs you a file you wanted gone, erring the other way costs you a file you needed. In the same spirit, a token that cannot be resolved but looks like a filename gets recorded, so a candidate sharing that name is flagged rather than ticked.

**Unknowable in principle.** Another vault, a Publish/Quartz/Hugo build, an Anki deck, an external tool, an `obsidian://` URI somewhere off-vault, or a symlink target outside the vault. Files under `.obsidian/` — theme snippets, other plugins' `data.json` — are invisible to `vault.getFiles()` and are not swept, so an image referenced only from a CSS snippet is not seen. Keeping the destination recoverable and the confirmation on is the mitigation.
