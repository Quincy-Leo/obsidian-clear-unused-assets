/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// clear.js — unused-attachment discovery + deletion, kept out of the UI layer
// ---------------------------------------------------------------------------
//
// This module answers two questions: "which attachment files is no note in
// this vault referencing?" and "how do I delete the ones the user picked?".
// It knows about Obsidian's `metadataCache`, the vault file tree, and the four
// delete destinations. It knows NOTHING about Notices, modals, or settings
// rendering — src/main.js owns those and drives this module through the
// {@link ClearAssetsJob} class exported below.
//
// The interface is shaped around one asymmetry that dominates the whole
// feature: a MISSED reference deletes a file the user still needs, while a
// SPURIOUS reference merely keeps a file they wanted gone. So gathering
// references is transactional — any file this module cannot read or parse sets
// `unsafe`, and an unsafe gather aborts the run instead of deleting from a
// partial reference set. Every result therefore carries enough structure for
// main.js to explain a refusal rather than silently deleting.
//
// The reference set is the UNION of two passes, and the union direction is
// always safe because an extra hit only keeps a file:
//
//   1. `metadataCache` — wikilinks, Markdown links, embeds, frontmatter links,
//      and (on recent Obsidian) canvas nodes, already resolved to paths.
//   2. A raw-text sweep of every text-ish file — for the references the
//      Markdown parser does not produce at all: `<img src>`, CSS `url(...)`,
//      bare frontmatter paths, `.base` view config, and canvas keys the cache
//      does not index.
//
// Pass 2 costs one `cachedRead` per text file. That is the price of not
// deleting a screenshot someone sized with raw HTML.

const { normalizePath } = require("obsidian");

const { isUnderFolder } = require("./scope");

// Gather outcomes. A reason is `{ kind, path }` where `kind` is one of these
// and `path` names the file that caused it — main.js renders the path into the
// abort message so the user can go and look at it.
//   REASON_READ_FAILED  — a text-ish file could not be read at all.
//   REASON_PARSE_FAILED — it was read but could not be understood (bad canvas
//                         JSON, a compressed Excalidraw payload, …).
//   REASON_VAULT_CHANGED— the vault mutated mid-scan, so the reference set
//                         mixes pre- and post-edit state.
//   REASON_SUSPICIOUS   — the candidate list is implausibly large (see
//                         SUSPICIOUS_CANDIDATE_RATIO). Carries no path; instead
//                         it carries `{ candidates, total }`, the two counts
//                         that tripped it, because `run()` does not promise to
//                         return the candidate list on an aborted run.
const REASON_READ_FAILED = "read-failed";
const REASON_PARSE_FAILED = "parse-failed";
const REASON_VAULT_CHANGED = "vault-changed";
const REASON_SUSPICIOUS = "suspicious";

// Candidate flags. A flagged candidate is still reported, but starts UNTICKED
// in the confirm modal: it is a file this module believes is unreferenced yet
// cannot vouch for.
//   FLAG_DUPLICATE_BASENAME — another vault file shares its basename, so a
//                             `[[name.png]]` link elsewhere may have resolved
//                             to the other copy by shortest-path rules, leaving
//                             this one looking unused when it is the intended
//                             target.
//   FLAG_TEXT_ONLY_MATCH    — a path-like token equal to its basename appears
//                             in some file's raw text but did not resolve to
//                             any vault file (`<img src="../old/logo.png">`
//                             after a folder rename). Somebody meant a file by
//                             this name and the link is merely broken.
//   FLAG_UNRESOLVED_LINK    — its basename appears in Obsidian's own
//                             `unresolvedLinks`, i.e. the app saw a link with
//                             this name and could not resolve it either
//                             (NFC/NFD skew, a renamed folder).
const FLAG_DUPLICATE_BASENAME = "duplicate-basename";
const FLAG_TEXT_ONLY_MATCH = "text-only-match";
const FLAG_UNRESOLVED_LINK = "unresolved-link";

// Tripwire: when this fraction or more of the in-scope attachments look
// unreferenced, the scan is treated as wrong rather than as a very dirty vault.
// A cold `metadataCache` produces exactly this signature — an empty reference
// set and therefore a near-total candidate list.
const SUSPICIOUS_CANDIDATE_RATIO = 0.9;

// …but only once there are enough attachments for the ratio to mean anything.
// A vault with three unused screenshots is a plausible 100%; a vault with
// hundreds is not.
const SUSPICIOUS_MIN_TOTAL = 10;

// Text-ish extensions the raw sweep always reads. `.md` and `.canvas` are
// covered by the cache but re-read here anyway, because the cache misses raw
// `<img src>` in Markdown and the `group.background` key in older canvases.
//
// This list is NOT the gate — see KNOWN_BINARY_EXTENSIONS. It exists so the
// common cases are recognised without a read, and so the list of formats this
// plugin knows something about is written down somewhere.
const SWEEP_EXTENSIONS = new Set([
    "md", "markdown", "mdx", "canvas", "base", "excalidraw",
    "svg", "html", "htm", "css", "txt", "text", "log",
    "json", "json5", "jsonc", "xml", "yml", "yaml", "toml", "ini", "csv", "tsv",
    "js", "mjs", "cjs", "ts", "jsx", "tsx", "mermaid", "tex", "bib", "org", "rst",
]);

// Extensions the sweep must NOT read: their bytes are not text, so reading them
// buys nothing and costs a full file load.
//
// Everything not listed here IS read, even when its extension is unfamiliar.
// That inversion is deliberate: an unread text file loses whatever references it
// held, which is exactly how a live attachment becomes a delete candidate. A
// user script, a `.excalidraw` scene, a `.yml` config — none of those were in
// the original allowlist, and each one silently cost a file.
const KNOWN_BINARY_EXTENSIONS = new Set([
    // images
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "avif", "tif", "tiff", "ico",
    "heic", "heif", "psd", "ai", "eps", "raw", "cr2", "nef", "arw", "dng",
    // audio / video
    "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aiff", "wma",
    "mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "m4v", "3gp", "mpg", "mpeg",
    // documents and archives
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "epub", "mobi", "azw3",
    // fonts, binaries, databases
    "ttf", "otf", "woff", "woff2", "eot", "exe", "dll", "so", "dylib", "bin",
    "dmg", "iso", "apk", "app", "wasm", "class", "jar", "pyc", "o", "a",
    "db", "sqlite", "sqlite3", "realm", "pack", "idx",
]);

// A NUL byte means the "text" file was binary after all — some format not in
// the list above. Skip it rather than abort: an unrecognised binary holds no
// text references, so nothing is lost by not parsing it.
const BINARY_SNIFF_CHARS = 512;

// Excalidraw stores its scene as base64/deflate inside this fence when the
// user enables "Compress Excalidraw JSON in Markdown". The embedded-file
// wikilinks are then not present as text, so NO parser — not the cache, not our
// sweep — can see which images the drawing uses. Decoding needs an inflate
// implementation this plugin deliberately does not bundle, so a compressed
// drawing aborts the run instead of silently dropping its references.
//   matches: "```compressed-json", "~~~compressed-json"
const COMPRESSED_JSON_FENCE_RE = /^\s*(?:```|~~~)compressed-json\s*$/m;

// Every shape of internal reference the raw sweep looks for. All of them are
// deliberately over-eager — a false hit only keeps a file — but each one must
// capture the raw target string in group 1 so `_addToken` can try it.
//   `![[a.png|300]]`, `[[a.png#heading]]`   → wiki links and embeds
//   `![alt](<a b.png>)`, `[t](a.png "x")`   → Markdown links, spaced form first
//   `<img src="a.png">`, `xlink:href='a.svg'` → raw HTML / SVG, quoted
//   `url(a.png)`, `url("a.png")`            → CSS
//   `"file": "a.canvas"`, `image: "a.png"`  → quoted key/value (canvas, base)
//   `banner: assets/a.png`                  → UNQUOTED key/value, which is how
//                                             frontmatter is normally written
//                                             and what the link cache misses
// The last pattern is the catch-all: any delimiter-bounded token that ends in a
// file extension. It exists because the shapes people actually use are
// unbounded — `<img src=a.png>` without quotes, `[ref]: a.png`, `srcset`,
// `image-set()`, YAML list items (`- assets/a.png`), a path written in prose —
// and enumerating them is a losing game when the cost of missing one is a
// deleted file. It only ever ADDS keeps: a token that resolves to no vault file
// is discarded, and one that does resolve was a real filename somebody wrote.
//
// Two details are load-bearing:
//   - It consumes a delimiter on the LEFT rather than relying on the engine to
//     retry every offset. Without that, one long delimiter-free run (an inline
//     base64 data URI, which every uncompressed Excalidraw scene contains) is
//     re-scanned from each start position: 80 KB took 4.9 s, 160 KB took 20 s,
//     all of it blocking the UI thread because this loop is synchronous.
//   - The token may contain SPACES, bounded to keep the scan linear. Obsidian's
//     own default paste name is `Pasted image 20260101120000.png`, so a
//     space-free pattern misses the single most common attachment name in
//     existence; `_addToken` then tries progressively shorter suffixes.
const SWEEP_PATTERNS = [
    /!?\[\[([^[\]|#\n]+)(?:[|#][^[\]\n]*)?\]\]/g,
    /!?\[[^\]\n]*\]\(\s*<([^>\n]+)>[^)]*\)/g,
    /!?\[[^\]\n]*\]\(\s*([^)<>"'\s]+)[^)]*\)/g,
    /(?:src|href|xlink:href|data|data-src|poster|srcset)\s*=\s*["']([^"'>\n]+)["']/gi,
    /url\(\s*["']?([^)"'\n]+?)["']?\s*\)/gi,
    /["']?(?:file|background|banner|cover|image|images|thumbnail|icon|src|path)["']?\s*[:=]\s*["']([^"'\n]+)["']/gi,
    /(?:^|[\s,{[])(?:file|background|banner|cover|image|images|thumbnail|icon|src|path)\s*:\s*([^"'\n,\]}]+)/gim,
    /(?:^|[\s<>"'`(){}[\],;!*|=])([^\s<>"'`(){}[\],;!*|=][^<>"'`(){}[\],;!*|=\n]{0,180}?\.[A-Za-z0-9]{1,10})(?=$|[\s<>"'`(){}[\],;!*|])/g,
];

// Tokens the sweep must not even try to resolve: they cannot name a vault file,
// and trying wastes a `getAbstractFileByPath` per occurrence.
//
// A bare `scheme:` prefix is NOT enough to reject on: `note:2.png` is a legal
// filename on macOS and Linux, and rejecting it would delete the file without
// even flagging it. So only a scheme followed by `//`, or one of the schemes
// that actually appear in notes, counts as external.
//   matches: "https://x/a.png", "data:image/png;base64,…", "#heading", "//host/a"
//   mismatches: "note:2.png", "a.png", "sub/a.png"
const EXTERNAL_TOKEN_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|#|\/\/)/i;
const EXTERNAL_SCHEMES = new Set([
    "http", "https", "data", "mailto", "tel", "file", "ftp", "ftps", "sftp",
    "obsidian", "app", "capacitor", "blob", "about", "javascript", "chrome",
    "zotero", "hook", "message", "callback", "shortcuts", "x-devonthink-item",
]);

// A trailing extension plausible enough to remember an unresolved token by.
// Requires a letter so a version number ("1.2.3") or an ordinal ("no.1") does
// not end up flagging a real file that happens to share the "name".
//   matches: ".png", ".jpeg", ".tar", ".mp4", ".x1"
//   mismatches: ".3", ".123", ".", ""
const PLAUSIBLE_EXTENSION_RE = /\.(?=[A-Za-z0-9]{1,10}$)[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/;

// Yield to the UI thread every this many files so a vault with thousands of
// notes does not freeze Obsidian for the whole scan or the whole delete pass.
const YIELD_EVERY = 50;

// How many leading words to peel off a spaced token before giving up. A
// filename with more than this many spaces is vanishingly rare; a prose line
// with more is not, and each variant costs a vault lookup.
const MAX_SPACED_VARIANTS = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Let the event loop (and the repaint) run. */
function yieldToUi() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** NFC so a path typed on one platform matches the same file spelled on another. */
function nfc(value) {
    return String(value).normalize("NFC");
}

/**
 * Is this token something other than a vault path — a URL, a data URI, a bare
 * fragment? Deliberately narrow: `note:2.png` is a legal filename, so a bare
 * `word:` prefix does not qualify.
 *
 * @param {string} token
 */
function isExternalToken(token) {
    if (EXTERNAL_TOKEN_RE.test(token)) return true;
    const colon = token.indexOf(":");
    if (colon <= 0) return false;
    return EXTERNAL_SCHEMES.has(token.slice(0, colon).toLowerCase());
}

/**
 * Undo the transport encoding of a link target without touching anything that
 * could be part of a filename. Percent-decoding and `<…>` wrapping are always
 * safe to undo; `|300`, `#heading` and `?v=2` are NOT, because a file may
 * legitimately be named `a#b.png` — {@link cleanToken} strips those, and
 * {@link ClearAssetsJob._addToken} tries both forms.
 *
 * @param {string} token Raw captured target.
 * @returns {string} A vault-relative-looking path, or "" if nothing is left.
 */
function decodeToken(token) {
    let out = String(token).trim().replace(/^<|>$/g, "").trim();
    if (out === "") return "";
    try {
        out = decodeURIComponent(out);
    } catch (_) {
        // A stray `%` that is not an escape sequence — use the raw text, which
        // is what the filename most likely is.
    }
    return nfc(out.replace(/\\/g, "/").replace(/^(?:\.\/)+/, ""));
}

/**
 * Strip everything Obsidian allows after the path inside a link target.
 *
 * The decoration is removed BEFORE percent-decoding, because a decoded `%23` is
 * a literal `#` in a filename and must not then be read as a subpath separator.
 * A filename that really does contain `#`, `?` or `|` is lost here by design —
 * {@link ClearAssetsJob._addToken} therefore also tries {@link decodeToken}'s
 * undecorated form, so such a file is still recognised when it exists.
 *
 * @param {string} token Raw captured target, e.g. `"a b.png#^blk"`, `"a.png|300"`.
 * @returns {string} A vault-relative-looking path, or "" if nothing is left.
 */
function cleanToken(token) {
    const trimmed = String(token).trim().replace(/^<|>$/g, "").trim();
    if (trimmed === "") return "";
    // `|300` (size), `#heading`, `#^block`, `?v=2` are all reference decoration.
    const bare = trimmed.split("|")[0].split("#")[0].split("?")[0].trim();
    if (bare === "") return "";
    return decodeToken(bare);
}

/** Last path segment, NFC-normalised. */
function basenameOf(path) {
    const p = nfc(path);
    const cut = p.lastIndexOf("/");
    return cut === -1 ? p : p.slice(cut + 1);
}

/** Parent folder of a vault path, or "" for a root-level file. */
function dirnameOf(path) {
    const cut = String(path).lastIndexOf("/");
    return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * A spaced token is ambiguous: `- assets/Pasted image 1.png` may be the whole
 * filename, or prose followed by one. Yield the full token first, then the
 * suffix after each space, so the most specific reading wins and the caller
 * still recognises `Pasted image 1.png` when the bullet is not part of the name.
 *
 * Bounded so a long prose line cannot turn into a quadratic lookup storm.
 *
 * @param {string} token
 * @returns {string[]}
 */
function spacedVariants(token) {
    if (!token.includes(" ")) return [token];
    const variants = [token];
    let rest = token;
    while (variants.length < MAX_SPACED_VARIANTS) {
        const cut = rest.indexOf(" ");
        if (cut === -1) break;
        rest = rest.slice(cut + 1);
        if (rest === "") break;
        variants.push(rest);
    }
    return variants;
}

/** Join a folder and a possibly-relative path, resolving `.` and `..`. */
function resolveRelative(fromDir, relative) {
    const segments = [];
    const base = relative.startsWith("/") ? [] : String(fromDir || "").split("/");
    for (const segment of base.concat(relative.split("/"))) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            // Refuse to climb out of the vault: pop only when there is
            // something to pop, otherwise the path is not ours to resolve.
            if (segments.length === 0) return "";
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.join("/");
}

/**
 * Encapsulates the "find and delete unreferenced attachments" job.
 *
 * Lifecycle mirrors `ResizeImagesJob` in the sibling plugin: `cancel()` is
 * synchronous and invalidates the current run by bumping a generation, so an
 * unload or a second trigger cannot let a stale continuation delete anything.
 */
class ClearAssetsJob {
    /**
     * @param {import("obsidian").Plugin} plugin
     */
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this._cancelGeneration = 0;
        // Set once Obsidian reports its initial link resolution complete. A scan
        // before that point sees a near-empty `resolvedLinks` and would call
        // almost every attachment unreferenced.
        this._cacheResolved = false;
        this._registerCacheGate();
    }

    /**
     * Listen for the one-shot `resolved` event on `metadataCache`. Registered
     * through `Plugin.registerEvent` when available so Obsidian tears it down
     * with the plugin; a bare `on()` is the fallback for a host (or a test
     * double) without it.
     */
    _registerCacheGate() {
        const cache = this.app && this.app.metadataCache;
        if (!cache || typeof cache.on !== "function") return;
        const ref = cache.on("resolved", () => { this._cacheResolved = true; });
        if (this.plugin && typeof this.plugin.registerEvent === "function") {
            try {
                this.plugin.registerEvent(ref);
            } catch (_) {
                // Optional: a host without event bookkeeping still gets the flag,
                // and the listener dies with the plugin's own metadataCache ref.
            }
        }
    }

    /**
     * Invalidate the current run synchronously. A subsequent run captures the
     * updated generation, so cancelling does not permanently disable the job.
     */
    cancel() {
        this._cancelGeneration += 1;
    }

    /** Token captured at the start of a run and re-checked after every await. */
    _newRunToken() {
        const generation = this._cancelGeneration;
        return {
            generation,
            isCancelled: () => this._cancelGeneration !== generation,
        };
    }

    /**
     * True once Obsidian has finished its initial link resolution. A scan run
     * before this point sees a near-empty `resolvedLinks` and would report
     * almost every attachment as unreferenced.
     *
     * @returns {boolean}
     */
    isCacheReady() {
        if (this._cacheResolved) return true;
        // `resolved` fires when initial resolution completes, and a plugin
        // enabled after startup misses that firing. A populated `resolvedLinks`
        // is the same signal read directly, so a late-loaded plugin is not stuck
        // refusing until the next vault edit.
        //
        // The bound is the MARKDOWN file count, not the total: `.base` files (and
        // `.canvas` on hosts before 1.12) are returned by `getFiles()` but
        // indexed by nothing, so a test against the total can never be satisfied
        // in a vault that contains one. Notes are the files that definitely get a
        // `resolvedLinks` key, and attachments add keys of their own, so this is
        // a lower bound that a warm cache always clears and a cold one does not.
        const cache = this.app && this.app.metadataCache;
        const links = cache && cache.resolvedLinks;
        if (!links) return false;
        const keys = Object.keys(links).length;
        if (keys === 0) return false;
        const notes = this._markdownFileCount();
        if (keys >= Math.max(1, notes)) {
            this._cacheResolved = true;
            return true;
        }
        return false;
    }

    /** How many notes the vault holds — the files certain to be indexed. */
    _markdownFileCount() {
        const vault = this.app && this.app.vault;
        if (vault && typeof vault.getMarkdownFiles === "function") {
            const files = vault.getMarkdownFiles();
            if (Array.isArray(files)) return files.length;
        }
        return this._allFiles().filter((f) => String(f.extension).toLowerCase() === "md").length;
    }

    /** Every `TFile` in the vault, or `[]` when the vault cannot be listed. */
    _allFiles() {
        const vault = this.app && this.app.vault;
        if (!vault || typeof vault.getFiles !== "function") return [];
        const files = vault.getFiles();
        return Array.isArray(files) ? files : [];
    }

    /**
     * Collect every attachment path the vault references, from all sources:
     * `metadataCache.resolvedLinks`, a recursive frontmatter walk, canvas and
     * base files, and a raw-text sweep for references the Markdown parser does
     * not produce (`<img src>`, `url(...)`, bare frontmatter paths).
     *
     * Fails closed: any file that cannot be read or understood sets `unsafe`
     * and records a reason, and the caller must NOT delete anything from an
     * unsafe result — a file skipped here looks unreferenced precisely because
     * its references were not counted.
     *
     * @returns {Promise<{
     *   referenced: Set<string>,
     *   textOnly: Set<string>,
     *   unresolved: Set<string>,
     *   unsafe: boolean,
     *   reasons: Array<{ kind: string, path: string }>,
     *   cancelled: boolean,
     * }>}
     */
    async gatherReferences() {
        const token = this._newRunToken();
        const result = {
            referenced: new Set(),
            textOnly: new Set(),
            unresolved: new Set(),
            unsafe: false,
            reasons: [],
            cancelled: false,
        };

        this._collectFromCache(result);
        if (token.isCancelled()) return { ...result, cancelled: true };

        const files = this._allFiles();
        let processed = 0;
        for (const file of files) {
            // Read everything that is not a KNOWN binary, rather than only what
            // is on a text allowlist: an unread text file silently loses whatever
            // references it held, and that is precisely how a live attachment
            // becomes a delete candidate.
            if (!this._shouldSweep(file)) continue;
            const outcome = await this._sweepFile(file, result);
            if (token.isCancelled()) return { ...result, cancelled: true };
            if (outcome) {
                // Fail closed and stop immediately: the caller must not delete
                // from a reference set that is missing this file's contribution,
                // and continuing would only lengthen the wait before refusing.
                result.unsafe = true;
                result.reasons.push(outcome);
                return result;
            }
            processed += 1;
            if (processed % YIELD_EVERY === 0) {
                await yieldToUi();
                if (token.isCancelled()) return { ...result, cancelled: true };
            }
        }
        return result;
    }

    /**
     * Should this file's raw text be scanned for references?
     *
     * Known text formats: yes. Known binary formats: no. Anything else: yes —
     * the unfamiliar extension might be a user script, a config file, or a
     * format that did not exist when this list was written, and each of those
     * can hold the only reference to an attachment.
     */
    _shouldSweep(file) {
        const extension = String(file.extension || "").toLowerCase();
        if (SWEEP_EXTENSIONS.has(extension)) return true;
        return !KNOWN_BINARY_EXTENSIONS.has(extension);
    }

    /**
     * Fold `metadataCache.resolvedLinks` and `unresolvedLinks` into the result.
     *
     * `resolvedLinks` is keyed by EVERY cached file, attachments included, and
     * its inner keys are already vault-absolute paths — so the union of all
     * inner keys is the referenced set. `unresolvedLinks`' inner keys are link
     * TEXTS, not paths, and only feed the flag vocabulary.
     */
    _collectFromCache(result) {
        const cache = this.app && this.app.metadataCache;
        const resolved = (cache && cache.resolvedLinks) || {};
        for (const targets of Object.values(resolved)) {
            if (!targets) continue;
            for (const target of Object.keys(targets)) result.referenced.add(nfc(target));
        }
        const unresolved = (cache && cache.unresolvedLinks) || {};
        for (const targets of Object.values(unresolved)) {
            if (!targets) continue;
            // Obsidian could not resolve these itself; record the basename so a
            // candidate with the same name can be flagged rather than deleted.
            for (const text of Object.keys(targets)) {
                const cleaned = cleanToken(text);
                if (cleaned !== "") result.unresolved.add(basenameOf(cleaned).toLowerCase());
            }
        }
    }

    /**
     * Read one text-ish file and add every reference its raw text implies.
     *
     * @returns {Promise<{ kind: string, path: string } | null>} A reason when the
     *     file could not be read or understood — the caller turns that into an
     *     abort. `null` on success.
     */
    async _sweepFile(file, result) {
        const vault = this.app && this.app.vault;
        let text = "";
        try {
            text = typeof vault.cachedRead === "function"
                ? await vault.cachedRead(file)
                : await vault.read(file);
        } catch (error) {
            console.error("clear-unused-assets: failed to read", file.path, error);
            return { kind: REASON_READ_FAILED, path: file.path };
        }
        if (typeof text !== "string") return { kind: REASON_READ_FAILED, path: file.path };

        // A NUL byte in the first block means this was a binary format after all
        // — some container not on the known-binary list. Skip it: an unknown
        // binary holds no text references, so nothing is lost.
        if (text.slice(0, BINARY_SNIFF_CHARS).includes("\u0000")) return null;

        const extension = String(file.extension).toLowerCase();
        if (extension === "canvas") {
            // A canvas is JSON; unparseable JSON means its node list — and
            // therefore its file references — are unknown.
            try {
                this._collectFromCanvas(JSON.parse(text), file, result);
            } catch (error) {
                console.error("clear-unused-assets: failed to parse", file.path, error);
                return { kind: REASON_PARSE_FAILED, path: file.path };
            }
        } else if (COMPRESSED_JSON_FENCE_RE.test(text)) {
            // Compressed Excalidraw: the embedded-file links are not text, so
            // nothing can see them. Refuse rather than under-count. Checked for
            // every extension, not just `md` — the same fence appears in
            // `.excalidraw` files and in whatever the plugin writes next.
            return { kind: REASON_PARSE_FAILED, path: file.path };
        }

        this._collectFromText(text, file, result);
        return null;
    }

    /**
     * Walk a parsed canvas. `file` nodes carry the path directly; `group` nodes
     * can carry a `background` image; `text` nodes hold Markdown, which the
     * generic text sweep handles.
     */
    _collectFromCanvas(canvas, sourceFile, result) {
        const nodes = canvas && Array.isArray(canvas.nodes) ? canvas.nodes : [];
        for (const node of nodes) {
            if (!node || typeof node !== "object") continue;
            for (const key of ["file", "background"]) {
                if (typeof node[key] === "string") {
                    this._addToken(node[key], sourceFile, result);
                }
            }
        }
    }

    /** Run every sweep pattern over one file's text. */
    _collectFromText(text, sourceFile, result) {
        for (const pattern of SWEEP_PATTERNS) {
            // Patterns are module-level and /g, so lastIndex must be reset
            // before each use or a previous file's offset would skip matches.
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                this._addToken(match[1], sourceFile, result);
                // Rewind to just past the captured target rather than past the
                // whole match. Several patterns end in a permissive tail
                // (`[^)]*`) that can swallow following text — an unclosed
                // `![](<a.png>` eats the next line's reference entirely — and a
                // reference hidden that way becomes a ticked delete candidate.
                const offset = match[1] === undefined ? -1 : match[0].indexOf(match[1]);
                if (offset >= 0) {
                    pattern.lastIndex = match.index + offset + match[1].length;
                }
                // A zero-length match would spin forever.
                if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
            }
        }
    }

    /**
     * Resolve one raw token to a vault file and record it.
     *
     * Resolution mirrors how Obsidian itself resolves a link, widest last: the
     * vault-absolute path, the path relative to the source file's folder, then
     * Obsidian's own shortest-path search. Each is tried for both the decorated
     * and the undecorated spelling of the token, because a file may genuinely be
     * named `a#1.png` while `a` is also a real note.
     *
     * EVERY hit is recorded rather than the first: one token can plausibly name
     * two different files (`photo #2.png` the file, versus `photo` + a subpath),
     * and keeping both is the safe reading. A token that resolves to nothing but
     * looks like a filename is remembered by basename, so a candidate with that
     * name is flagged instead of silently deleted.
     */
    _addToken(rawToken, sourceFile, result) {
        const token = cleanToken(rawToken);
        // A genuinely external token is dropped entirely — not even remembered,
        // because `https://x.com/a.png` says nothing about a vault file that
        // happens to share the basename. Note that `isExternalToken` is narrow
        // on purpose: `note:2.png` is a legal filename and falls through here to
        // be resolved like any other path.
        if (token === "" || isExternalToken(token)) return;
        const undecorated = decodeToken(rawToken);
        const tokens = undecorated !== "" && undecorated !== token
            ? [token, undecorated]
            : [token];

        const vault = this.app && this.app.vault;
        const cache = this.app && this.app.metadataCache;
        const sourcePath = sourceFile && sourceFile.path;

        let resolved = false;
        for (const attempt of tokens) {
            // A spaced token may be one filename or a filename preceded by
            // prose. Try the whole thing first, then progressively drop leading
            // words — "Pasted image 2026.png" resolves whole, while
            // "- assets/a.png" only resolves after the bullet is dropped.
            for (const variant of spacedVariants(attempt)) {
                const candidates = [variant];
                const relative = resolveRelative(dirnameOf(sourcePath || ""), variant);
                if (relative !== "" && relative !== variant) candidates.push(relative);
                for (const candidate of candidates) {
                    const normalized = nfc(normalizePath(candidate));
                    const entry = vault && typeof vault.getAbstractFileByPath === "function"
                        ? vault.getAbstractFileByPath(normalized)
                        : null;
                    if (entry && typeof entry.extension === "string") {
                        result.referenced.add(nfc(entry.path));
                        resolved = true;
                    }
                }
                if (cache && typeof cache.getFirstLinkpathDest === "function") {
                    const dest = cache.getFirstLinkpathDest(variant, sourcePath || "");
                    if (dest && typeof dest.path === "string") {
                        result.referenced.add(nfc(dest.path));
                        resolved = true;
                    }
                }
                // The whole token resolving is the confident case; a suffix
                // resolving is enough to stop widening but not to stop trying
                // the undecorated spelling.
                if (resolved) break;
            }
        }
        if (resolved) return;
        this._rememberUnresolved(rawToken, token, result);
    }

    /**
     * Remember an unresolvable token by basename so a candidate with that name is
     * flagged rather than deleted.
     *
     * Records several spellings, because the one that matches a real file's
     * basename is not knowable here: the decoded form (a reference written
     * `my%20photo.jpg` for a file named `my photo.jpg`), the raw form (a file
     * literally named `my%20photo.jpg`, which is what a browser download
     * produces), and — for a spaced token — the suffix after each space, since
     * `- assets/Pasted image 1.png` carries the real basename only in its tail.
     */
    _rememberUnresolved(rawToken, cleaned, result) {
        const forms = new Set();
        for (const spelling of [cleaned, String(rawToken).trim()]) {
            if (spelling === "") continue;
            for (const variant of spacedVariants(spelling)) {
                forms.add(basenameOf(variant));
            }
        }
        for (const base of forms) {
            if (base !== "" && PLAUSIBLE_EXTENSION_RE.test(base)) {
                result.textOnly.add(base.toLowerCase());
            }
        }
    }

    /**
     * Diff the reference set against the in-scope attachments.
     *
     * Candidates are plain records keyed by PATH rather than `TFile` handles:
     * the confirm modal waits on a human, and a rename during that wait mutates
     * a `TFile` in place, which would leave the modal displaying one file while
     * holding a reference to another.
     *
     * @param {Awaited<ReturnType<ClearAssetsJob["gatherReferences"]>>} references
     * @param {ReturnType<typeof import("./scope").resolveScope>} scope
     * @returns {{
     *   candidates: Array<{ path: string, extension: string, size: number, flags: string[] }>,
     *   total: number,
     *   suspicious: boolean,
     * }}
     */
    findCandidates(references, scope) {
        const extensions = new Set(scope.extensions.map((e) => String(e).toLowerCase()));
        const inScope = [];
        // Basename census over the WHOLE vault, not just the in-scope slice: a
        // duplicate living outside the target folder is exactly the case where
        // shortest-path resolution picks the other copy.
        const basenameCounts = new Map();
        for (const file of this._allFiles()) {
            const base = basenameOf(file.path).toLowerCase();
            basenameCounts.set(base, (basenameCounts.get(base) || 0) + 1);
            if (!extensions.has(String(file.extension).toLowerCase())) continue;
            if (!this._isInScope(file.path, scope)) continue;
            inScope.push(file);
        }

        const candidates = [];
        for (const file of inScope) {
            // Identity is the vault's OWN spelling, not an NFC-normalised one:
            // `getAbstractFileByPath` is composition-sensitive, so a normalised
            // path would not find an NFD-named file at delete time and the user
            // would be told it went "missing" on every single run. Normalisation
            // is applied only to the comparisons below.
            const path = String(file.path);
            const normalized = nfc(path);
            if (references.referenced.has(normalized)) continue;
            const base = basenameOf(normalized).toLowerCase();
            const flags = [];
            if ((basenameCounts.get(base) || 0) > 1) flags.push(FLAG_DUPLICATE_BASENAME);
            if (references.unresolved.has(base)) flags.push(FLAG_UNRESOLVED_LINK);
            if (references.textOnly.has(base)) flags.push(FLAG_TEXT_ONLY_MATCH);
            candidates.push({
                path,
                extension: String(file.extension).toLowerCase(),
                size: (file.stat && Number.isFinite(file.stat.size)) ? file.stat.size : 0,
                flags,
            });
        }
        // Stable order so the modal reads like the file explorer rather than
        // like whatever order the vault happened to enumerate.
        candidates.sort((a, b) => (a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)));

        const total = inScope.length;
        const suspicious = total >= SUSPICIOUS_MIN_TOTAL
            && candidates.length / total >= SUSPICIOUS_CANDIDATE_RATIO;
        return { candidates, total, suspicious };
    }

    /**
     * Is this file inside the run's delete scope? Include first, then exclude —
     * excluding wins, which is what makes an excluded folder nested inside a
     * target folder behave as a protected hole.
     */
    _isInScope(path, scope) {
        const included = scope.includeFolders.some((folder) => isUnderFolder(path, folder));
        if (!included) return false;
        return !scope.excludeFolders.some((folder) => isUnderFolder(path, folder));
    }

    /**
     * Scan and diff in one call — the entry point main.js uses.
     *
     * On an aborted run `candidates` is empty: a partial candidate list must not
     * be shown as if it were the answer. Everything the abort message needs is
     * therefore carried on `abortReason` itself.
     *
     * @param {ReturnType<typeof import("./scope").resolveScope>} scope
     * @returns {Promise<{
     *   candidates: Array<{ path: string, extension: string, size: number, flags: string[] }>,
     *   total: number,
     *   aborted: boolean,
     *   abortReason: {
     *     kind: string,
     *     path?: string,
     *     candidates?: number,
     *     total?: number,
     *   } | null,
     *   cancelled: boolean,
     * }>}
     */
    async run(scope) {
        const token = this._newRunToken();
        const empty = {
            candidates: [],
            total: 0,
            aborted: false,
            abortReason: null,
            cancelled: false,
        };

        // Snapshot the vault before scanning and compare after: a note edited
        // mid-scan means the reference set mixes pre- and post-edit state, and
        // the post-edit half is the half that could be missing a reference.
        const before = this._vaultFingerprint();
        const references = await this.gatherReferences();
        if (token.isCancelled() || references.cancelled) return { ...empty, cancelled: true };
        if (references.unsafe) {
            return { ...empty, aborted: true, abortReason: references.reasons[0] };
        }
        if (this._vaultFingerprint() !== before) {
            return {
                ...empty,
                aborted: true,
                abortReason: { kind: REASON_VAULT_CHANGED, path: "" },
            };
        }

        const { candidates, total, suspicious } = this.findCandidates(references, scope);
        if (token.isCancelled()) return { ...empty, cancelled: true };
        if (suspicious) {
            // Report the counts on the reason: an aborted run returns no
            // candidate list, so the numbers have to travel with the reason.
            return {
                ...empty,
                total,
                aborted: true,
                abortReason: {
                    kind: REASON_SUSPICIOUS,
                    path: "",
                    candidates: candidates.length,
                    total,
                },
            };
        }
        return { candidates, total, aborted: false, abortReason: null, cancelled: false };
    }

    /**
     * A cheap value that changes whenever the set of files, their sizes, or
     * their mtimes change. Compared before and after a scan to detect concurrent
     * edits.
     *
     * A sum would collide on an add+delete pair or on two offsetting mtime
     * changes, so this folds every path in as well — the point is to be hard to
     * fool by accident, since a missed change means the reference set mixes
     * pre- and post-edit state.
     */
    _vaultFingerprint() {
        let hash = 0x811c9dc5;
        let count = 0;
        for (const file of this._allFiles()) {
            count += 1;
            const stat = file.stat || {};
            const record = `${file.path}\u0000${stat.mtime || 0}\u0000${stat.size || 0}`;
            for (let i = 0; i < record.length; i++) {
                // FNV-1a, 32-bit. Cheap, order-independent enough for our use
                // (paths come out of the vault in a stable order), and it does
                // not need to be cryptographic — only sensitive to any edit.
                hash ^= record.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193);
            }
        }
        return `${count}:${(hash >>> 0).toString(16)}`;
    }

    /**
     * Delete the paths the user confirmed.
     *
     * Re-verifies before deleting rather than trusting the snapshot: the
     * confirm modal can sit open for minutes, during which Sync can deliver a
     * note that references a candidate. Anything that became referenced, or
     * that no longer exists, is reported in `kept` instead of deleted.
     *
     * @param {string[]} paths Vault-absolute paths, as shown in the modal.
     * @param {{
     *   destination: string,
     *   onProgress?: (progress: { current: number, total: number, path: string }) => void,
     * }} options
     * @returns {Promise<{
     *   deleted: string[],
     *   kept: Array<{ path: string, reason: string }>,
     *   failed: Array<{ path: string, error: string }>,
     *   destinationUsed: string,
     *   cancelled: boolean,
     * }>}
     */
    async deleteSelected(paths, options) {
        const token = this._newRunToken();
        const destination = (options && options.destination) || ".trash";
        const onProgress = (options && options.onProgress) || (() => {});
        const result = {
            deleted: [],
            kept: [],
            failed: [],
            destinationUsed: destination,
            cancelled: false,
        };
        const wanted = Array.isArray(paths) ? paths : [];
        if (wanted.length === 0) return result;

        // Re-verify against a FRESH reference set. The confirm modal can sit open
        // for minutes, and Sync can deliver a note referencing a candidate in
        // that window; deleting from the old snapshot would lose a live file.
        //
        // Fingerprint around the re-verify too: `gatherReferences` snapshots the
        // file list once at its start, so a note that arrives WHILE it runs is
        // never read. `run()` already guards this; the irreversible path needs it
        // at least as much.
        const before = this._vaultFingerprint();
        const references = await this.gatherReferences();
        if (token.isCancelled() || references.cancelled) {
            return { ...result, cancelled: true };
        }
        if (references.unsafe) {
            // The same fail-closed rule as the scan: an incomplete reference set
            // cannot clear anything for deletion.
            return {
                ...result,
                kept: wanted.map((path) => ({ path, reason: "verify-failed" })),
            };
        }
        if (this._vaultFingerprint() !== before) {
            return {
                ...result,
                kept: wanted.map((path) => ({ path, reason: "vault-changed" })),
            };
        }

        const vault = this.app && this.app.vault;
        let index = 0;
        for (const path of wanted) {
            index += 1;
            if (token.isCancelled()) return { ...result, cancelled: true };
            const normalized = nfc(path);
            if (references.referenced.has(normalized)) {
                result.kept.push({ path, reason: "now-referenced" });
                continue;
            }
            const entry = vault && typeof vault.getAbstractFileByPath === "function"
                ? vault.getAbstractFileByPath(path)
                : null;
            if (!entry || typeof entry.extension !== "string") {
                // Renamed or already deleted while the modal was open. Not an
                // error, and definitely not something to delete by path.
                result.kept.push({ path, reason: "missing" });
                continue;
            }
            onProgress({ current: index, total: wanted.length, path });
            try {
                const used = await this._deleteOne(entry, destination);
                // Record the destination actually used, not the one requested:
                // an old host without `trashFile` falls back, and the user has to
                // be told where their files really went.
                result.destinationUsed = used;
                result.deleted.push(path);
            } catch (error) {
                console.error("clear-unused-assets: failed to delete", path, error);
                result.failed.push({
                    path,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            if (index % YIELD_EVERY === 0) {
                await yieldToUi();
                if (token.isCancelled()) return { ...result, cancelled: true };
            }
        }
        return result;
    }

    /**
     * Send one file to the configured destination.
     *
     * `vault.trash(file, true)` already falls back to the vault-local `.trash`
     * when the OS trash is unavailable, so a returned `"system-trash"` means
     * "asked for the system trash", not "it definitely went there" — that
     * fallback is invisible to plugins. The fallback this DOES report is the
     * `trashFile` one, which is ours to see.
     *
     * @returns {Promise<string>} The destination actually used.
     */
    async _deleteOne(file, destination) {
        const vault = this.app.vault;
        if (destination === "permanent") {
            await vault.delete(file);
            return "permanent";
        }
        if (destination === "system-trash") {
            await vault.trash(file, true);
            return "system-trash";
        }
        if (destination === ".trash") {
            await vault.trash(file, false);
            return ".trash";
        }
        // "obsidian-setting": defer to the user's own "Deleted files" preference.
        // trashFile landed in Obsidian 1.6.6 and the manifest floor is 1.4.0, so
        // fall back to the vault-local trash, the recoverable option, when the
        // host is too old to have it.
        const fileManager = this.app.fileManager;
        if (fileManager && typeof fileManager.trashFile === "function") {
            await fileManager.trashFile(file);
            return "obsidian-setting";
        }
        await vault.trash(file, false);
        return ".trash";
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    ClearAssetsJob,
    REASON_READ_FAILED,
    REASON_PARSE_FAILED,
    REASON_VAULT_CHANGED,
    REASON_SUSPICIOUS,
    FLAG_DUPLICATE_BASENAME,
    FLAG_TEXT_ONLY_MATCH,
    FLAG_UNRESOLVED_LINK,
    SUSPICIOUS_CANDIDATE_RATIO,
    SUSPICIOUS_MIN_TOTAL,
    SWEEP_EXTENSIONS,
    cleanToken,
    decodeToken,
    resolveRelative,
};
