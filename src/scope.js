/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// scope.js — "which files may this run touch?", resolved from the settings
// ---------------------------------------------------------------------------
//
// This module owns one question and the vocabulary it needs: given a settings
// snapshot and the real vault, which folders and extensions are in scope — or,
// when the configuration cannot be honoured, why not. `resolveScope()` is the
// single answer, and both callers go through it: src/main.js before a run and
// the settings page for its inline validation, so the page can never call a
// configuration valid that a run would then refuse.
//
// It knows about the vault file tree and nothing else: no i18n (problems are
// reported as `{ key, params }` pairs for the caller to render), no
// persistence, no DOM. src/settings.js owns the strings and `data.json` and
// requires this module; this module must never require back into it.

const { TFolder } = require("obsidian");

// Image formats Obsidian renders inline. Deliberately excludes `md`, `canvas`
// and `base` — see PROTECTED_EXTENSIONS.
const DEFAULT_EXTENSIONS = "png,jpg,jpeg,gif,bmp,svg,webp,avif";

// Documents, not attachments. A standalone note, canvas or base legitimately
// has zero inbound links, so "unreferenced" says nothing about whether it is
// wanted. Listing one in the extension setting is ignored rather than obeyed.
const PROTECTED_EXTENSIONS = new Set(["md", "canvas", "base"]);

// Obsidian represents the vault root as "/" (getAbstractFileByPath("") is
// null, getAbstractFileByPath("/") is the root TFolder), so an empty folder
// list canonicalises to this rather than to "".
const VAULT_ROOT = "/";

// A path the user must not type into the folder lists, tested BEFORE
// normalizePath because normalizePath erases the evidence ("/a" → "a",
// "C:\x" → "C:/x").
//   matches: "/assets", "\\server\share", "C:\pics", "~/pics"
//   mismatches: "assets", "assets/img", "./assets", "../assets"
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|~)/;

// What a `TFile.extension` can actually look like. A token that cannot equal one
// is rejected rather than kept, so a space- or semicolon-separated list reports
// "the extension list is empty" instead of silently matching nothing.
//   matches: "png", "jpeg", "tar-gz", "mp4", "x_1"
//   mismatches: "png jpg", "png;jpg", "p*g", "png/", ""
const EXTENSION_RE = /^[a-z0-9_-]+$/;

/**
 * The scope-relevant fields of a settings snapshot, at their defaults. They
 * live here, next to the code that interprets them, and `defaultSettings()` in
 * src/settings.js spreads this in — so the defaults a run resolves and the
 * defaults that get persisted cannot drift apart.
 */
function defaultScopeSettings() {
    return {
        includeFolders: "",
        excludeFolders: "",
        extensions: DEFAULT_EXTENSIONS,
    };
}

// ---------------------------------------------------------------------------
// Parsing + validation — shared by the settings page and the run-time refusal
// ---------------------------------------------------------------------------

/**
 * Canonicalise one folder-list line so two spellings of the same folder
 * compare equal. Mirrors Obsidian's `normalizePath` (backslashes → `/`,
 * collapse runs, strip leading/trailing `/`, NFC) but additionally trims
 * whitespace, which `normalizePath` does not, and resolves nothing — `..`
 * is rejected by {@link validateFolderList} rather than resolved.
 *
 * @param {string} line
 * @returns {string} Canonical vault-relative path, or "" for a blank line.
 */
function canonicalizeFolderPath(line) {
    const trimmed = String(line).trim();
    if (trimmed === "") return "";
    const slashed = trimmed
        .replace(/[\\/]+/g, "/")
        .replace(/^(?:\.\/)+/, "")
        .replace(/^\/+|\/+$/g, "");
    // Normalising to NFC on both sides of every comparison keeps a folder
    // typed here equal to the same folder as spelled by macOS, which hands
    // out NFD filenames.
    return slashed.normalize("NFC");
}

/**
 * Split a multiline folder setting into one record per non-blank line.
 *
 * Lines are NOT de-duplicated here: validation has to see every raw spelling,
 * because dropping a duplicate early would also drop its raw line — and an
 * absolute path typed as the second spelling of an already-seen folder would
 * then never be rejected. De-duplication happens after validation.
 *
 * @param {string} raw
 * @returns {{ paths: string[], lines: Array<{ path: string, raw: string }> }}
 *     `lines` keeps every non-blank line in order; `paths` is the de-duplicated
 *     canonical list, used only to tell an empty list from a bad one.
 */
function parseFolderList(raw) {
    const lines = [];
    const paths = [];
    const seen = new Set();
    for (const line of String(raw || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        const canonical = canonicalizeFolderPath(trimmed);
        // A line of only slashes canonicalises to "" — that is the vault root
        // spelled as "/", which the empty-list convention already covers.
        const path = canonical === "" ? VAULT_ROOT : canonical;
        lines.push({ path, raw: trimmed });
        // A Set rather than an object: a folder literally named `__proto__`
        // would defeat object-key bookkeeping and leak into an error message.
        if (seen.has(path)) continue;
        seen.add(path);
        paths.push(path);
    }
    return { paths, lines };
}

/**
 * Validate one folder list against the real vault.
 *
 * Both lists are validated equally strictly, and on purpose: a typo in
 * "folders to clean" merely produces no candidates, but a typo in "folders to
 * exclude" silently removes protection the user explicitly asked for. Both
 * therefore have to stop the run, not warn.
 *
 * @param {string} raw Raw multiline setting value.
 * @param {import("obsidian").Vault} vault
 * @param {"include" | "exclude"} kind Selects the message key prefix.
 * @returns {{
 *   folders: string[],
 *   listed: number,
 *   errors: Array<{ key: string, params: Record<string, string> }>,
 * }}
 *     `folders` is the de-duplicated set of folders that validated; `listed` is
 *     how many non-blank lines the user wrote, so the caller can tell an empty
 *     list from one where everything was rejected.
 */
function validateFolderList(raw, vault, kind) {
    const prefix = kind === "include" ? "includeFolder" : "excludeFolder";
    const { paths, lines } = parseFolderList(raw);
    const folders = [];
    const seen = new Set();
    const errors = [];
    /** Keep the first validated spelling of each folder, order preserved. */
    const accept = (path) => {
        if (seen.has(path)) return;
        seen.add(path);
        folders.push(path);
    };
    // Iterate every line, not the de-duplicated paths: a second spelling of an
    // already-accepted folder can still be an absolute path, and that has to be
    // refused no matter which line it appeared on.
    for (const { path, raw: original } of lines) {
        // A line that is nothing but separators ("/", "./") names the vault
        // root. It is checked before the absoluteness test below because a bare
        // "/" here unambiguously means "the whole vault", not a filesystem root.
        if (path === VAULT_ROOT) {
            accept(VAULT_ROOT);
            continue;
        }
        // Absoluteness is tested on the RAW line: normalizePath and our own
        // canonicalizer both turn "/assets" into "assets" and "C:\pics" into
        // "C:/pics", so by canonical form the evidence is already gone.
        if (ABSOLUTE_PATH_RE.test(original)) {
            errors.push({ key: `${prefix}Absolute`, params: { path: original } });
            continue;
        }
        // ".." is neither resolved nor followed: it can only ever point outside
        // the vault, which this plugin has no business touching.
        if (path.split("/").includes("..")) {
            errors.push({ key: `${prefix}Absolute`, params: { path: original } });
            continue;
        }
        const entry = vault && typeof vault.getAbstractFileByPath === "function"
            ? vault.getAbstractFileByPath(path)
            : null;
        if (!entry) {
            errors.push({ key: `${prefix}Missing`, params: { path: original } });
            continue;
        }
        if (!isFolderEntry(entry)) {
            errors.push({ key: `${prefix}NotFolder`, params: { path: original } });
            continue;
        }
        // Store the vault's own spelling so later prefix tests compare against
        // the canonical case/composition rather than whatever was typed.
        accept(String(entry.path).normalize("NFC"));
    }
    return { folders, listed: paths.length, errors };
}

/**
 * `instanceof TFolder` where the class is available, structural check
 * otherwise. Test doubles and future Obsidian builds both stay supported:
 * a folder is the thing that has `children`.
 */
function isFolderEntry(entry) {
    if (!entry) return false;
    if (typeof TFolder === "function" && entry instanceof TFolder) return true;
    return Array.isArray(entry.children);
}

/**
 * True when `path` is inside `folder` (or is that folder). Prefix tests are
 * anchored on a trailing "/" so "assets" does not swallow "assets-old", and
 * the vault root matches everything.
 *
 * @param {string} path Vault-absolute file or folder path.
 * @param {string} folder Canonical folder path, or VAULT_ROOT.
 */
function isUnderFolder(path, folder) {
    if (folder === VAULT_ROOT) return true;
    const p = String(path).normalize("NFC");
    const f = String(folder).normalize("NFC");
    return p === f || p.startsWith(`${f}/`);
}

/**
 * Parse the comma-separated extension setting into a lower-case set.
 * Leading dots and `*.` are tolerated, blanks dropped, and documents
 * ({@link PROTECTED_EXTENSIONS}) removed even when explicitly listed —
 * "unreferenced" is a normal state for a note, canvas or base, so obeying
 * `md` here would delete the user's vault.
 *
 * Anything that cannot be a file extension is rejected rather than kept: a
 * token like `"png jpg"` (space-separated instead of comma-separated) can never
 * equal a `TFile.extension`, so keeping it would leave the configuration
 * looking valid while every run reported "nothing to delete".
 *
 * @param {string} raw
 * @returns {{ extensions: string[], rejected: string[] }}
 */
function parseExtensions(raw) {
    const extensions = [];
    const rejected = [];
    const seen = new Set();
    for (const piece of String(raw || "").split(/[,\n\r]/)) {
        const cleaned = piece.trim().replace(/^[*.\s]+/, "").replace(/\.+$/, "").toLowerCase();
        if (cleaned === "") continue;
        if (PROTECTED_EXTENSIONS.has(cleaned) || !EXTENSION_RE.test(cleaned)) {
            if (!rejected.includes(cleaned)) rejected.push(cleaned);
            continue;
        }
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        extensions.push(cleaned);
    }
    return { extensions, rejected };
}

// ---------------------------------------------------------------------------
// The one answer
// ---------------------------------------------------------------------------

/**
 * Resolve a settings snapshot into the concrete scope a run needs, or into the
 * list of reasons it must not run. main.js calls this from its entry point and
 * the settings page renders the same result inline, so the two can never
 * disagree about what a valid configuration is.
 *
 * @param {ReturnType<typeof import("./settings").defaultSettings>} value
 * @param {import("obsidian").Vault} vault
 * @returns {{
 *   ok: boolean,
 *   errors: Array<{ key: string, params: Record<string, string> }>,
 *   includeFolders: string[],
 *   excludeFolders: string[],
 *   extensions: string[],
 *   rejectedExtensions: string[],
 * }}
 */
function resolveScope(value, vault) {
    // Only the scope fields are defaulted here — requiring settings.js for its
    // full `defaultSettings()` would make the dependency circular, and no other
    // field is read below.
    const settings = value || defaultScopeSettings();
    const include = validateFolderList(settings.includeFolders, vault, "include");
    const exclude = validateFolderList(settings.excludeFolders, vault, "exclude");
    const { extensions, rejected } = parseExtensions(settings.extensions);
    const errors = include.errors.concat(exclude.errors);

    // An empty include list means the whole vault — but a list whose every line
    // was rejected must NOT widen to the whole vault. `ok` is false either way,
    // so nothing runs today; the difference matters because this object is the
    // one contract src/clear.js is written against, and its failure mode has to
    // be "nothing in scope", not "everything".
    const includeFolders = include.folders.length > 0
        ? include.folders
        : (include.listed === 0 ? [VAULT_ROOT] : []);

    if (extensions.length === 0) errors.push({ key: "extensionsEmpty", params: {} });

    // A target folder that lies entirely inside an excluded folder can never
    // produce a candidate. Silently scanning and reporting "nothing to delete"
    // would read as a bug, so say what is wrong instead. One error per target
    // folder: listing every excluded ancestor would repeat the same complaint.
    for (const folder of includeFolders) {
        const shadow = exclude.folders.find((excluded) => isUnderFolder(folder, excluded));
        if (shadow !== undefined) {
            errors.push({
                key: "includeFolderShadowed",
                params: { path: folder, other: shadow },
            });
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        includeFolders,
        excludeFolders: exclude.folders,
        extensions,
        rejectedExtensions: rejected,
    };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
//
// 其他模块会调用的接口：
//   - resolveScope              把配置解析成本次运行的范围或拒绝原因
//                               （main.js 运行前调用，设置页就地校验也调它）
//   - isUnderFolder             目录递归匹配（clear.js 判断文件是否在范围内）
//   - parseFolderList           多行目录设置解析（去空行、去重、根目录归一）
//   - canonicalizeFolderPath    单行目录路径归一（斜杠、./、NFC）
//   - parseExtensions           扩展名解析（含 md/canvas/base 剔除）
//   - defaultScopeSettings      范围相关字段的默认值（settings.js 展开进默认配置）
//   - PROTECTED_EXTENSIONS      永不作为附件删除的扩展名（md / canvas / base）
//   - VAULT_ROOT                仓库根目录的规范写法（"/"）
//
// 本模块不含用户操作直接触发的接口：它是纯函数集合，由 settings.js 的设置页与
// main.js 的运行入口调用。
module.exports = {
    resolveScope,
    isUnderFolder,
    parseExtensions,
    parseFolderList,
    canonicalizeFolderPath,
    defaultScopeSettings,
    PROTECTED_EXTENSIONS,
    VAULT_ROOT,
};
