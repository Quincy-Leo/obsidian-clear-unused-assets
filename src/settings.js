/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// settings.js — persisted configuration, the i18n table, and the settings page
// ---------------------------------------------------------------------------
//
// This module owns three things and nothing else:
//
//   1. LANGUAGE_OPTIONS — every user-visible string in both languages.
//   2. ClearAssetsSettings — reading/writing `data.json`, including the
//      `version` field policy (see SETTINGS_SCHEMA_VERSION below).
//   3. ClearAssetsSettingTab — the settings page, which renders the verdict of
//      `resolveScope()` inline so the page and the run-time refusal always
//      agree on what a bad configuration looks like.
//
// It knows NOTHING about scanning the vault or deleting files — src/clear.js
// owns those, src/scope.js owns what a valid configuration means, and
// src/main.js wires them together.

const { Notice, PluginSettingTab, Setting } = require("obsidian");

const {
    defaultScopeSettings,
    resolveScope,
} = require("./scope");

const NOTICE_DURATION_MS = 4000;

// Text fields persist on a debounce rather than per keystroke: every save
// re-reads `data.json` to apply the version policy, so per-keystroke saves
// would mean one read-modify-write cycle per typed character.
const TEXT_SAVE_DEBOUNCE_MS = 500;

const LANGUAGE_OPTIONS = [
    {
        value: "zh-CN",
        label: "中文",
        commandName: "清理未被引用的附件",
        ribbonTitle: "清理未被引用的附件",
        notice: {
            start: "clear-unused-assets：正在扫描未被引用的附件……",
            nothing: "clear-unused-assets：没有未被引用的附件，未删除任何文件。",
            cancelled: "clear-unused-assets：已取消，未删除任何文件。",
            deleted:
                "clear-unused-assets：已删除 {deleted} 个附件（保留 {kept}，失败 {failed}）。",
            destinationFallback:
                "clear-unused-assets：删除去向从 {requested} 回退为 {used}。",
        },
        error: {
            settingsIllegalVersion:
                "clear-unused-assets：配置文件的 “version” 字段非法（{actual}）；期望值为 {expected}。",
            settingsVersionTooNew:
                "clear-unused-assets：配置文件版本 {actual} 高于插件支持的 {expected}；请升级插件。",
            settingsUnreadable:
                "clear-unused-assets：读取配置文件失败（{message}）；功能已暂停，请到设置页修复。",
            settingsCorrupt:
                "clear-unused-assets：配置文件存在但无法解析；为避免覆盖你的配置，功能已暂停，请到设置页修复。",
            settingsWriteFailed:
                "clear-unused-assets：写入配置文件失败（{message}）；功能已暂停。",
            settingsUnusable:
                "clear-unused-assets：配置文件不可用，功能已暂停；请到设置页修复后再试。",
            includeFolderAbsolute: "clear-unused-assets：清理目录不能填绝对路径：{path}。",
            includeFolderMissing: "clear-unused-assets：清理目录不存在：{path}。",
            includeFolderNotFolder: "clear-unused-assets：清理目录不是一个目录：{path}。",
            includeFolderShadowed:
                "clear-unused-assets：清理目录 {path} 整个位于排除目录 {other} 之内，配置自相矛盾。",
            excludeFolderAbsolute: "clear-unused-assets：排除目录不能填绝对路径：{path}。",
            excludeFolderMissing: "clear-unused-assets：排除目录不存在：{path}。",
            excludeFolderNotFolder: "clear-unused-assets：排除目录不是一个目录：{path}。",
            extensionsEmpty:
                "clear-unused-assets：要清理的扩展名为空；请到设置页填写后再试。",
            cacheNotReady: "clear-unused-assets：Obsidian 仍在建立索引，请稍后重试。",
            scanReadFailed:
                "clear-unused-assets：无法读取 {path}，无法确认它引用了哪些附件；为避免误删已中止。",
            scanParseFailed:
                "clear-unused-assets：无法解析 {path}，无法确认它引用了哪些附件；为避免误删已中止。",
            scanVaultChanged: "clear-unused-assets：扫描期间仓库发生变化，请重试。",
            scanSuspicious:
                "clear-unused-assets：扫描结果异常（{candidates}/{total} 个附件都没有被引用），可能是索引未就绪；为避免误删已中止。",
        },
        settingsText: {
            languageName: "Language / 语言",
            languageDesc: "插件显示的界面语言",
            brokenConfigHeading: "配置文件异常",
            brokenConfigDesc:
                "无法读取 data.json，下面显示的是插件的默认设置，功能入口已暂停。点击 “修复配置文件” 会把旧文件备份为 data.json.bak，再按当前显示的设置重新写入。",
            repairButton: "修复配置文件",
            repairDone: "clear-unused-assets：配置文件已修复。",
            scopeHeading: "清理范围",
            includeFoldersName: "清理目录",
            includeFoldersDesc:
                "相对于仓库根目录的相对路径，一行一个；留空表示整个仓库。子目录一并处理。",
            includeFoldersPlaceholder: "留空表示整个仓库\nassets\n附件/图片",
            excludeFoldersName: "排除目录",
            excludeFoldersDesc:
                "相对于仓库根目录的相对路径，一行一个；留空表示不排除。子目录一并排除。排除只缩小删除范围，引用扫描始终覆盖整个仓库。",
            excludeFoldersPlaceholder: "留空表示不排除\nassets/长期保留",
            extensionsName: "要清理的扩展名",
            extensionsDesc:
                "英文逗号分隔，不区分大小写，可以带点。md、canvas、base 属于文档而非附件，填了也会被忽略。",
            extensionsPlaceholder: "png,jpg,jpeg,gif,bmp,svg,webp,avif",
            deleteHeading: "删除方式",
            deleteDestinationName: "删除到哪里",
            deleteDestinationDesc: "选择被删除的附件的去向。",
            deleteDestinationObsidianSetting: "跟随 Obsidian 设置",
            deleteDestinationTrash: "移到 Obsidian 回收站（.trash）",
            deleteDestinationSystemTrash: "移到系统回收站",
            deleteDestinationPermanent: "永久删除（不可恢复）",
            confirmName: "删除前需要确认",
            confirmDesc:
                "开启后会先列出待删除的文件供逐项勾选。关闭则直接删除，建议仅在删除方式可恢复时关闭。",
            confirmForcedOn:
                "clear-unused-assets：“永久删除” 不可恢复，已自动开启删除前确认。",
            resetHeading: "重置",
            resetName: "重置所有设置",
            resetDesc: "把全部设置恢复为默认值，并立即写入 data.json。",
            resetButton: "重置所有设置",
            resetDone: "clear-unused-assets：已重置所有设置。",
            validationOk: "配置有效。",
            validationTitle: "配置有问题：",
            modalTitle: "确认删除未被引用的附件",
            modalSummary: "共找到 {total} 个未被引用的附件；取消勾选表示保留该文件。",
            modalFlaggedHint:
                "其中 {count} 个存在疑点（同名文件、仅在纯文本里出现等），已默认不勾选。",
            modalSelectAll: "全选",
            modalSelectNone: "全不选",
            modalTruncated: "……另有 {count} 个文件未显示；它们默认不勾选，本次不会被删除。",
            modalDeleteButton: "删除选中的 {count} 项",
            modalCancelButton: "取消",
            modalDestinationTrash: "去向：Obsidian 回收站（.trash）",
            modalDestinationSystemTrash: "去向：系统回收站",
            modalDestinationPermanent: "去向：永久删除，不可恢复",
            modalDestinationObsidianSetting: "去向：跟随 Obsidian 的 “已删除的文件” 设置",
        },
    },
    {
        value: "en",
        label: "English",
        commandName: "Clear unused assets",
        ribbonTitle: "Clear unused assets",
        notice: {
            start: "clear-unused-assets: scanning for unreferenced attachments…",
            nothing: "clear-unused-assets: every attachment is referenced; nothing was deleted.",
            cancelled: "clear-unused-assets: cancelled; nothing was deleted.",
            deleted:
                "clear-unused-assets: deleted {deleted} attachment(s) ({kept} kept, {failed} failed).",
            destinationFallback:
                "clear-unused-assets: the destination fell back from {requested} to {used}.",
        },
        error: {
            settingsIllegalVersion:
                "clear-unused-assets: settings file has an illegal \"version\" field ({actual}); expected {expected}.",
            settingsVersionTooNew:
                "clear-unused-assets: settings file version {actual} is newer than this plugin supports ({expected}); please upgrade the plugin.",
            settingsUnreadable:
                "clear-unused-assets: failed to read the settings file ({message}); the plugin is paused — repair it on the settings page.",
            settingsCorrupt:
                "clear-unused-assets: the settings file exists but cannot be parsed; the plugin is paused so your configuration is not overwritten — repair it on the settings page.",
            settingsWriteFailed:
                "clear-unused-assets: failed to write the settings file ({message}); the plugin is paused.",
            settingsUnusable:
                "clear-unused-assets: the settings file is unusable and the plugin is paused; repair it on the settings page and try again.",
            includeFolderAbsolute:
                "clear-unused-assets: a target folder must not be an absolute path: {path}.",
            includeFolderMissing: "clear-unused-assets: target folder does not exist: {path}.",
            includeFolderNotFolder: "clear-unused-assets: target path is not a folder: {path}.",
            includeFolderShadowed:
                "clear-unused-assets: target folder {path} lies entirely inside excluded folder {other}; the configuration contradicts itself.",
            excludeFolderAbsolute:
                "clear-unused-assets: an excluded folder must not be an absolute path: {path}.",
            excludeFolderMissing: "clear-unused-assets: excluded folder does not exist: {path}.",
            excludeFolderNotFolder:
                "clear-unused-assets: excluded path is not a folder: {path}.",
            extensionsEmpty:
                "clear-unused-assets: the extension list is empty; fill it in on the settings page and try again.",
            cacheNotReady:
                "clear-unused-assets: Obsidian is still indexing the vault; please try again shortly.",
            scanReadFailed:
                "clear-unused-assets: cannot read {path}, so its attachment references are unknown; aborted to avoid deleting a file that is still in use.",
            scanParseFailed:
                "clear-unused-assets: cannot parse {path}, so its attachment references are unknown; aborted to avoid deleting a file that is still in use.",
            scanVaultChanged:
                "clear-unused-assets: the vault changed during the scan; please try again.",
            scanSuspicious:
                "clear-unused-assets: the scan result looks wrong ({candidates} of {total} attachments appear unreferenced), most likely because the index is not ready; aborted to avoid deleting files that are still in use.",
        },
        settingsText: {
            languageName: "Language",
            languageDesc: "Interface language for plugin.",
            brokenConfigHeading: "Broken settings file",
            brokenConfigDesc:
                "data.json could not be read, so the values below are the plugin defaults and both entry points are paused. \"Repair settings file\" backs the old file up as data.json.bak and rewrites it from the values shown here.",
            repairButton: "Repair settings file",
            repairDone: "clear-unused-assets: the settings file has been repaired.",
            scopeHeading: "Scope",
            includeFoldersName: "Folders to clean",
            includeFoldersDesc:
                "Vault-relative paths, one per line; leave empty for the whole vault. Subfolders are included.",
            includeFoldersPlaceholder: "empty = whole vault\nassets\nattachments/images",
            excludeFoldersName: "Folders to exclude",
            excludeFoldersDesc:
                "Vault-relative paths, one per line; leave empty to exclude nothing. Subfolders are excluded too. Excluding only narrows what may be deleted — the reference scan always covers the whole vault.",
            excludeFoldersPlaceholder: "empty = exclude nothing\nassets/keep-forever",
            extensionsName: "Extensions to clean",
            extensionsDesc:
                "Comma-separated, case-insensitive, a leading dot is fine. md, canvas and base are documents rather than attachments and are ignored even if listed.",
            extensionsPlaceholder: "png,jpg,jpeg,gif,bmp,svg,webp,avif",
            deleteHeading: "Deletion",
            deleteDestinationName: "Deleted file destination",
            deleteDestinationDesc: "Where deleted attachments should go.",
            deleteDestinationObsidianSetting: "Follow the Obsidian setting",
            deleteDestinationTrash: "Move to Obsidian trash (.trash)",
            deleteDestinationSystemTrash: "Move to system trash",
            deleteDestinationPermanent: "Delete permanently (unrecoverable)",
            confirmName: "Confirm before deleting",
            confirmDesc:
                "When on, the candidate files are listed with a checkbox each. When off they are deleted straight away — only advisable with a recoverable destination.",
            confirmForcedOn:
                "clear-unused-assets: \"Delete permanently\" cannot be undone, so confirmation was turned back on.",
            resetHeading: "Reset",
            resetName: "Reset all settings",
            resetDesc: "Restore every setting to its default and write data.json immediately.",
            resetButton: "Reset all settings",
            resetDone: "clear-unused-assets: all settings have been reset.",
            validationOk: "The configuration is valid.",
            validationTitle: "Configuration problems:",
            modalTitle: "Confirm deletion of unreferenced attachments",
            modalSummary:
                "{total} unreferenced attachment(s) found; unticking a row keeps that file.",
            modalFlaggedHint:
                "{count} of them look suspicious (duplicate basename, plain-text-only match, …) and start unticked.",
            modalSelectAll: "Select all",
            modalSelectNone: "Select none",
            modalTruncated:
                "… {count} more file(s) are not shown; they start unticked and will not be deleted.",
            modalDeleteButton: "Delete {count} selected",
            modalCancelButton: "Cancel",
            modalDestinationTrash: "Destination: Obsidian trash (.trash)",
            modalDestinationSystemTrash: "Destination: system trash",
            modalDestinationPermanent: "Destination: permanent, unrecoverable",
            modalDestinationObsidianSetting:
                "Destination: whatever Obsidian's \"Deleted files\" setting says",
        },
    },
];

const DEFAULT_LANGUAGE = LANGUAGE_OPTIONS[0].value;

// Bump this when the on-disk schema changes in a way old code can't read.
// Unknown or missing versions are refused rather than silently migrated —
// migrations, when needed, will be added here explicitly. Purely additive
// fields must NOT bump it: a user who syncs `data.json` to an older install
// would find the plugin refusing to run over a field it could have ignored.
const SETTINGS_SCHEMA_VERSION = 1;

// Deletion targets. "obsidian-setting" defers to Obsidian's own
// "Files & Links → Deleted files" preference via FileManager.trashFile.
const DELETE_DESTINATIONS = ["obsidian-setting", ".trash", "system-trash", "permanent"];
const DEFAULT_DELETE_DESTINATION = ".trash";

/** Default settings snapshot. A fresh object each call — never share it. */
function defaultSettings() {
    return {
        version: SETTINGS_SCHEMA_VERSION,
        language: DEFAULT_LANGUAGE,
        // The scope fields live with the code that interprets them, so the
        // defaults a run resolves and the defaults persisted here are one value.
        ...defaultScopeSettings(),
        deleteDestination: DEFAULT_DELETE_DESTINATION,
        confirmBeforeDelete: true,
    };
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Render an error message in every supported language, joined on newlines.
 * Used ONLY for errors that can fire before we know which language the
 * user picked — chiefly settings-load failures (`settingsIllegalVersion`,
 * `settingsVersionTooNew`), which happen before `settings.value` exists.
 * Once settings are loaded, prefer {@link localizedError} so users don't
 * see two languages stacked together in one Notice.
 *
 * @param {string} key Key inside each LANGUAGE_OPTIONS entry's `error` object.
 * @param {Record<string, string | number>} [params] Placeholder values.
 */
function bilingualError(key, params = {}) {
    return LANGUAGE_OPTIONS
        .map((option) => formatTemplate(option.error[key] || "", params))
        .filter(Boolean)
        .join("\n");
}

/**
 * Render an error message in the currently-selected language. Use this
 * for runtime errors — anything that can only fire after
 * {@link ClearAssetsSettings.load} has resolved. The returned string
 * already begins with `clear-unused-assets:` / `clear-unused-assets：`, so
 * callers that feed it into a Notice should NOT prefix it again.
 *
 * @param {{ error: Record<string, string> }} uiText Typically `plugin.uiText`.
 * @param {string} key Key inside `uiText.error`.
 * @param {Record<string, string | number>} [params] Placeholder values.
 */
function localizedError(uiText, key, params = {}) {
    const template = (uiText && uiText.error && uiText.error[key]) || "";
    return formatTemplate(template, params);
}

/**
 * Substitute `{name}` placeholders. Split/join rather than a regex so a value
 * containing `$&` or `$1` is inserted verbatim.
 *
 * @param {string} template
 * @param {Record<string, string | number>} params
 */
function formatTemplate(template, params) {
    let out = template;
    for (const [name, value] of Object.entries(params)) {
        out = out.split(`{${name}}`).join(String(value));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

class ClearAssetsSettings {
    /**
     * @param {import("obsidian").Plugin} plugin
     * @param {() => void} [onChanged] Fired after a successful save (and after
     *     the rollback reload that follows a failed one) so main.js can
     *     refresh the localized command name and ribbon tooltip.
     */
    constructor(plugin, onChanged) {
        this.plugin = plugin;
        this.onChanged = onChanged || (() => {});
        this.value = null;
        // Non-null when `data.json` could not be read. The plugin still loads
        // with defaults in memory so the settings page is reachable, but both
        // entry points refuse to run until a repair clears this.
        this.loadError = null;
        this._saveGeneration = 0;
        // All writes queue on this chain. Each write re-reads `data.json` to
        // apply the version policy, and a read-modify-write cycle that can
        // interleave would let one save's backup overwrite another's.
        this._writeChain = Promise.resolve();
    }

    get uiText() {
        const language = this.value && this.value.language;
        return LANGUAGE_OPTIONS.find((option) => option.value === language)
            || LANGUAGE_OPTIONS[0];
    }

    /** True while `data.json` is unreadable and has not been repaired. */
    get broken() {
        return this.loadError !== null;
    }

    /**
     * Read `data.json`. A fresh install writes the defaults; an unreadable
     * file leaves the defaults in memory, records {@link loadError}, and
     * rethrows so main.js can surface the reason.
     *
     * @returns {Promise<ReturnType<typeof defaultSettings>>}
     */
    async load() {
        let savedData = null;
        try {
            savedData = await this.plugin.loadData();
        } catch (error) {
            // Obsidian's own loadData swallows parse errors, but a rejection is
            // still possible (permissions, a vault adapter failure). Treat it
            // exactly like an illegal file: keep defaults in memory so the
            // settings page renders, and record why so the repair path shows up.
            this.value = defaultSettings();
            this.loadError = new Error(bilingualError("settingsUnreadable", {
                message: error instanceof Error ? error.message : String(error),
            }));
            throw this.loadError;
        }
        const missing = savedData === null || savedData === undefined;
        // "No data" and "data I could not parse" both surface as null/undefined
        // from loadData — Obsidian logs the parse error and returns. Distinguish
        // them by asking the filesystem, because treating a corrupt file as a
        // fresh install would overwrite the user's configuration with defaults
        // and take no backup.
        const isFreshInstall = missing && !(await this._fileExistsOnDisk());
        if (missing && !isFreshInstall) {
            this.value = defaultSettings();
            this.loadError = new Error(bilingualError("settingsCorrupt"));
            throw this.loadError;
        }
        const saved = savedData && typeof savedData === "object" ? savedData : {};

        if (!isFreshInstall) {
            const version = saved.version;
            if (!Number.isInteger(version) || version < SETTINGS_SCHEMA_VERSION) {
                // Keep whatever fields ARE readable so the settings page shows
                // the user's own configuration and a repair preserves it rather
                // than silently resetting everything to defaults.
                this.value = coerceSettings(saved);
                this.loadError = new Error(bilingualError("settingsIllegalVersion", {
                    actual: JSON.stringify(version),
                    expected: SETTINGS_SCHEMA_VERSION,
                }));
                throw this.loadError;
            }
            if (version > SETTINGS_SCHEMA_VERSION) {
                this.value = coerceSettings(saved);
                this.loadError = new Error(bilingualError("settingsVersionTooNew", {
                    actual: JSON.stringify(version),
                    expected: SETTINGS_SCHEMA_VERSION,
                }));
                throw this.loadError;
            }
        }

        this.value = coerceSettings(saved);
        if (isFreshInstall) {
            // Route the first write through the same queue as every other one,
            // and only clear `loadError` once it has landed: a failed first write
            // must leave the settings page able to explain itself.
            try {
                await this._queueWrite(() => this.plugin.saveData({ ...this.value }));
            } catch (error) {
                this.loadError = new Error(bilingualError("settingsWriteFailed", {
                    message: error instanceof Error ? error.message : String(error),
                }));
                throw this.loadError;
            }
        }
        this.loadError = null;
        return this.value;
    }

    /**
     * Does `data.json` exist on disk? Used only to tell "never installed" from
     * "installed but unparseable", which `loadData()` reports identically.
     * A missing adapter is reported as "no file" — the same conservative reading
     * the plugin has always had for a vault it cannot inspect.
     */
    async _fileExistsOnDisk() {
        const path = this._dataPath();
        const adapter = this.plugin.app
            && this.plugin.app.vault
            && this.plugin.app.vault.adapter;
        if (!path || !adapter || typeof adapter.exists !== "function") return false;
        try {
            return await adapter.exists(path);
        } catch (error) {
            console.error("clear-unused-assets: failed to stat data.json", error);
            return false;
        }
    }

    /** Vault-relative path of our own `data.json`, or null if unknown. */
    _dataPath() {
        const dir = this.plugin.manifest && this.plugin.manifest.dir;
        return dir ? `${dir}/data.json` : null;
    }

    /**
     * Serialize a write onto {@link _writeChain}. Every write re-reads
     * `data.json` to apply the version policy, so a read-modify-write cycle that
     * could interleave would let one save's backup overwrite another's.
     */
    _queueWrite(work) {
        const run = this._writeChain.then(work, work);
        // Keep the chain alive after a rejection so one failed write does not
        // wedge every later one; the rejection is still delivered to `run`.
        this._writeChain = run.catch(() => {});
        return run;
    }

    async setLanguage(language) {
        if (!LANGUAGE_OPTIONS.some((option) => option.value === language)) return;
        await this._mutate({ language });
    }

    /**
     * Apply a partial update. Every field is re-coerced afterwards, so an
     * unusable value from a text field can never reach disk, and the
     * safety-critical pair (`permanent` + no confirmation) is repaired rather
     * than persisted.
     *
     * @param {Partial<ReturnType<typeof defaultSettings>>} patch
     */
    async setValues(patch) {
        await this._mutate(patch || {});
    }

    /** Restore every field to its default and persist immediately. */
    async reset() {
        await this._mutate(defaultSettings(), { replace: true });
    }

    /**
     * Rewrite `data.json` from the current in-memory values after backing up
     * the unreadable file. This is the one sanctioned bypass of the
     * "refuse to write when the on-disk version is newer" rule: refusing an
     * automatic write protects a newer sibling install's config, but refusing
     * an explicit repair would leave the user with no in-app way out.
     */
    async repair() {
        if (!this.value) this.value = defaultSettings();
        await this._mutate({}, { force: true });
    }

    /**
     * Shared mutator: replace the snapshot, queue the write, then notify.
     *
     * @param {Partial<ReturnType<typeof defaultSettings>>} patch
     * @param {{ replace?: boolean, force?: boolean }} [options]
     */
    async _mutate(patch, options = {}) {
        const base = options.replace ? patch : { ...(this.value || defaultSettings()), ...patch };
        // Replace the object instead of mutating the one that may already have
        // been handed to saveData(). Each save therefore owns an immutable
        // snapshot even when the user changes a control again immediately.
        this.value = coerceSettings(base);
        const generation = ++this._saveGeneration;
        await this.save(generation, options);
        if (generation === this._saveGeneration) this.onChanged();
    }

    /**
     * Persist the current snapshot. Writes are serialized on
     * {@link _writeChain} so the re-read/backup/write sequence is atomic with
     * respect to other saves.
     *
     * @param {number} [requestGeneration]
     * @param {{ force?: boolean }} [options]
     */
    async save(requestGeneration = this._saveGeneration, options = {}) {
        try {
            await this._queueWrite(() => this._writeNow(options));
            this.loadError = null;
        } catch (saveError) {
            // A stale failed save must not roll back a newer in-memory choice —
            // and the check has to be repeated AFTER the read, because a newer
            // edit can land while the disk read is in flight. Reading into a
            // local and only then assigning keeps the rollback from clobbering
            // an edit it never saw.
            if (requestGeneration === this._saveGeneration) {
                try {
                    const rollback = await this._readForRollback();
                    if (requestGeneration === this._saveGeneration) {
                        this.value = rollback.value;
                        // A rollback that finds an unusable file on disk has to
                        // leave the store broken: the entry points key their
                        // refusal off this, and the reason the write was rejected
                        // is exactly the reason a run must not proceed.
                        if (rollback.error) this.loadError = rollback.error;
                        this.onChanged();
                    }
                } catch (loadError) {
                    console.error(
                        "clear-unused-assets: failed to reload settings after save failure",
                        loadError,
                    );
                }
            }
            throw saveError;
        }
    }

    /**
     * Re-read the persisted snapshot for a rollback, without touching
     * `this.value` or `loadError` — the caller decides whether the result is
     * still wanted, because a newer edit may have landed during the read.
     *
     * @returns {Promise<{
     *   value: ReturnType<typeof defaultSettings>,
     *   error: Error | null,
     * }>}
     */
    async _readForRollback() {
        const verdict = await this._inspectOnDisk();
        const value = coerceSettings(verdict.saved || {});
        if (verdict.kind === "illegal") {
            return {
                value,
                error: new Error(bilingualError("settingsIllegalVersion", {
                    actual: JSON.stringify(verdict.version),
                    expected: SETTINGS_SCHEMA_VERSION,
                })),
            };
        }
        if (verdict.kind === "too-new") {
            return {
                value,
                error: new Error(bilingualError("settingsVersionTooNew", {
                    actual: JSON.stringify(verdict.version),
                    expected: SETTINGS_SCHEMA_VERSION,
                })),
            };
        }
        return { value, error: null };
    }

    /**
     * One serialized read-modify-write cycle: apply the on-disk version policy,
     * back the file up when it may hold something the user still wants, then
     * write the newest snapshot.
     */
    async _writeNow(options = {}) {
        const verdict = await this._inspectOnDisk();
        if (verdict.kind === "too-new" && !options.force) {
            throw new Error(bilingualError("settingsVersionTooNew", {
                actual: JSON.stringify(verdict.version),
                expected: SETTINGS_SCHEMA_VERSION,
            }));
        }
        // Back up whenever an existing file is about to be overwritten by
        // something other than a normal edit of a config we successfully read:
        // an illegal or too-new file obviously, but also any write taken while
        // the store is `broken`, because then `this.value` is a reconstruction
        // and the bytes on disk may be the only copy of the real settings.
        const overwritingUnknown = verdict.kind === "illegal"
            || verdict.kind === "too-new"
            || this.broken
            || Boolean(options.force);
        if (verdict.kind !== "missing" && overwritingUnknown) {
            await this._backupOnDisk();
        }
        // Snapshot AFTER the awaits above so a value changed while the backup
        // ran is the one that lands on disk.
        const snapshot = verdict.kind === "ok" && verdict.saved
            // Preserve keys this version does not know about: the version policy
            // exists to keep an older install from breaking a newer one's config,
            // and silently dropping its additive fields would break it anyway.
            ? { ...verdict.saved, ...this.value }
            : { ...this.value };
        await this.plugin.saveData(snapshot);
    }

    /**
     * Classify the current `data.json`.
     *
     * @returns {Promise<{
     *   kind: "missing" | "ok" | "illegal" | "too-new",
     *   version: unknown,
     *   saved: object | null,
     * }>}
     */
    async _inspectOnDisk() {
        let saved = null;
        try {
            saved = await this.plugin.loadData();
        } catch (error) {
            // An unreadable file is treated as illegal rather than fatal: the
            // backup path preserves whatever bytes are there before we write.
            console.error("clear-unused-assets: failed to re-read data.json", error);
            return { kind: "illegal", version: undefined, saved: null };
        }
        if (saved === null || saved === undefined) {
            // Unparseable reads land here too (loadData returns undefined), so
            // ask the filesystem before concluding there is nothing to preserve.
            const exists = await this._fileExistsOnDisk();
            return exists
                ? { kind: "illegal", version: undefined, saved: null }
                : { kind: "missing", version: undefined, saved: null };
        }
        if (typeof saved !== "object") return { kind: "illegal", version: undefined, saved: null };
        const version = saved.version;
        if (!Number.isInteger(version) || version < SETTINGS_SCHEMA_VERSION) {
            return { kind: "illegal", version, saved };
        }
        if (version > SETTINGS_SCHEMA_VERSION) return { kind: "too-new", version, saved };
        return { kind: "ok", version, saved };
    }

    /**
     * Copy `data.json` aside before overwriting it. The name carries a
     * timestamp and an existing file is never overwritten, so a second bad
     * write cannot destroy the first backup — which is the whole point of
     * taking one.
     */
    async _backupOnDisk() {
        const dir = this.plugin.manifest && this.plugin.manifest.dir;
        const source = this._dataPath();
        const adapter = this.plugin.app
            && this.plugin.app.vault
            && this.plugin.app.vault.adapter;
        if (!dir || !source || !adapter || typeof adapter.read !== "function") return;
        try {
            if (typeof adapter.exists === "function" && !(await adapter.exists(source))) return;
            const contents = await adapter.read(source);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            let target = `${dir}/data.${stamp}.json.bak`;
            if (typeof adapter.exists === "function") {
                let attempt = 2;
                while (await adapter.exists(target)) {
                    target = `${dir}/data.${stamp}-${attempt}.json.bak`;
                    attempt += 1;
                }
            }
            await adapter.write(target, contents);
            console.log("clear-unused-assets: backed up the old settings file to", target);
        } catch (error) {
            // Best-effort: the backup exists to help the user recover, and
            // failing to take one must not also block the repair they asked
            // for. The reason is logged so it is diagnosable.
            console.error("clear-unused-assets: failed to back up data.json", error);
        }
    }
}

/**
 * Coerce a raw object into a valid settings snapshot. Every field falls back to
 * its default individually and unknown keys are dropped, so a hand-edited or
 * partially-written file degrades to "some defaults" rather than to a crash.
 *
 * @param {Record<string, unknown>} saved
 * @returns {ReturnType<typeof defaultSettings>}
 */
function coerceSettings(saved) {
    const defaults = defaultSettings();
    const source = saved && typeof saved === "object" ? saved : {};
    const value = {
        version: SETTINGS_SCHEMA_VERSION,
        language: LANGUAGE_OPTIONS.some((option) => option.value === source.language)
            ? source.language
            : defaults.language,
        includeFolders: typeof source.includeFolders === "string"
            ? source.includeFolders
            : defaults.includeFolders,
        excludeFolders: typeof source.excludeFolders === "string"
            ? source.excludeFolders
            : defaults.excludeFolders,
        extensions: typeof source.extensions === "string"
            ? source.extensions
            : defaults.extensions,
        deleteDestination: DELETE_DESTINATIONS.includes(source.deleteDestination)
            ? source.deleteDestination
            : defaults.deleteDestination,
        // Anything other than an explicit `false` keeps the confirmation on:
        // this flag guards an irreversible operation, so a corrupted value must
        // fail towards asking rather than towards deleting.
        confirmBeforeDelete: source.confirmBeforeDelete !== false,
    };
    // Permanent deletion has no undo, so it is not allowed to run unattended
    // no matter what the file says.
    if (value.deleteDestination === "permanent") value.confirmBeforeDelete = true;
    return value;
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

class ClearAssetsSettingTab extends PluginSettingTab {
    /**
     * @param {import("obsidian").App} app
     * @param {ClearAssetsSettings} settings
     */
    constructor(app, settings) {
        super(app, settings.plugin);
        this.settings = settings;
        const plugin = settings.plugin;

        // Track asynchronous work so stale completions cannot write. The render
        // generation invalidates orphan DOM nodes.
        this._displayGeneration = 0;
        this._disposed = false;
        this._validationEl = null;
        // Pending debounced text saves, keyed by setting field.
        this._pendingSaves = new Map();

        try {
            if (!(plugin.__clearUnusedAssetsSettingTabs instanceof Set)) {
                plugin.__clearUnusedAssetsSettingTabs = new Set();
            }
            plugin.__clearUnusedAssetsSettingTabs.add(this);
        } catch (_) {
            // Optional lifecycle registration; a frozen host object should not
            // make the settings page unusable.
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._displayGeneration += 1;
        for (const timer of this._pendingSaves.values()) clearTimeout(timer);
        this._pendingSaves.clear();
    }

    _isDisposed() {
        return this._disposed
            || Boolean(this.settings.plugin && this.settings.plugin.__clearUnusedAssetsUnloaded);
    }

    /** Obsidian calls this when the settings page is closed. */
    hide() {
        // Flush pending text edits so switching away from the page does not
        // silently discard the last few characters the user typed.
        for (const [field, timer] of this._pendingSaves) {
            clearTimeout(timer);
            const patch = this._pendingValues && this._pendingValues.get(field);
            if (patch !== undefined) {
                void this._commit({ [field]: patch });
            }
        }
        this._pendingSaves.clear();
        if (this._pendingValues) this._pendingValues.clear();
    }

    display() {
        if (this._isDisposed()) return;
        const generation = ++this._displayGeneration;
        this.containerEl.empty();
        const text = this.settings.uiText.settingsText;
        // A failed load leaves defaults in `value` rather than null, so every
        // control below renders even when `data.json` is unreadable — that is
        // what makes the repair button reachable.
        const value = this.settings.value || defaultSettings();

        new Setting(this.containerEl)
            .setName(text.languageName)
            .setDesc(text.languageDesc)
            .addDropdown((dropdown) => {
                for (const option of LANGUAGE_OPTIONS) {
                    dropdown.addOption(option.value, option.label);
                }
                dropdown.setValue(value.language).onChange(async (language) => {
                    if (this._isDisposed()) return;
                    try {
                        await this.settings.setLanguage(language);
                    } catch (error) {
                        this._reportError(error);
                    } finally {
                        if (!this._isDisposed()) this.display();
                    }
                });
            });

        if (this.settings.broken) this._renderBrokenConfigSection(text, generation);
        this._renderScopeSection(text, value);
        this._renderDeleteSection(text, value, generation);
        this._renderResetSection(text, generation);
        this._refreshValidation();
    }

    /**
     * Shown only while `data.json` is unreadable. The controls above are live
     * regardless, so saving any one of them repairs the file too; this section
     * exists so the user does not have to guess that.
     */
    _renderBrokenConfigSection(text, generation) {
        // Use Setting.setHeading() so the section title inherits the same left
        // gutter and typography as Obsidian's built-in section headers.
        new Setting(this.containerEl).setName(text.brokenConfigHeading).setHeading();
        const setting = new Setting(this.containerEl).setDesc(text.brokenConfigDesc);
        const reasonEl = setting.descEl.createDiv({
            text: this.settings.loadError ? this.settings.loadError.message : "",
            cls: "clear-unused-assets-config-error",
        });
        reasonEl.style.marginTop = "0.75em";
        reasonEl.style.paddingTop = "0.6em";
        reasonEl.style.borderTop = "1px solid var(--background-modifier-border)";
        reasonEl.style.whiteSpace = "pre-wrap";
        setting.addButton((button) => {
            button.setButtonText(text.repairButton).setCta().onClick(async () => {
                if (this._isDisposed()) return;
                button.setDisabled(true);
                try {
                    await this.settings.repair();
                    if (this._isDisposed()) return;
                    new Notice(text.repairDone, NOTICE_DURATION_MS);
                } catch (error) {
                    this._reportError(error);
                } finally {
                    // An orphan handler must not mutate a newly-rendered button.
                    if (!this._isDisposed() && generation === this._displayGeneration) {
                        this.display();
                    }
                }
            });
        });
    }

    _renderScopeSection(text, value) {
        new Setting(this.containerEl).setName(text.scopeHeading).setHeading();

        new Setting(this.containerEl)
            .setName(text.includeFoldersName)
            .setDesc(text.includeFoldersDesc)
            .addTextArea((area) => {
                area.inputEl.rows = 4;
                area.setPlaceholder(text.includeFoldersPlaceholder)
                    .setValue(value.includeFolders)
                    .onChange((next) => this._queueSave("includeFolders", next));
            });

        new Setting(this.containerEl)
            .setName(text.excludeFoldersName)
            .setDesc(text.excludeFoldersDesc)
            .addTextArea((area) => {
                area.inputEl.rows = 4;
                area.setPlaceholder(text.excludeFoldersPlaceholder)
                    .setValue(value.excludeFolders)
                    .onChange((next) => this._queueSave("excludeFolders", next));
            });

        new Setting(this.containerEl)
            .setName(text.extensionsName)
            .setDesc(text.extensionsDesc)
            .addText((input) => {
                input.setPlaceholder(text.extensionsPlaceholder)
                    .setValue(value.extensions)
                    .onChange((next) => this._queueSave("extensions", next));
            });

        // Validation lives next to the fields it is about, and is refreshed in
        // place rather than raised as a Notice — the fields are edited
        // character by character, and a Notice per keystroke is unusable.
        const setting = new Setting(this.containerEl);
        this._validationEl = setting.descEl.createDiv({
            cls: "clear-unused-assets-validation",
        });
        this._validationEl.style.whiteSpace = "pre-wrap";
    }

    _renderDeleteSection(text, value, generation) {
        new Setting(this.containerEl).setName(text.deleteHeading).setHeading();

        new Setting(this.containerEl)
            .setName(text.deleteDestinationName)
            .setDesc(text.deleteDestinationDesc)
            .addDropdown((dropdown) => {
                dropdown.addOption("obsidian-setting", text.deleteDestinationObsidianSetting);
                dropdown.addOption(".trash", text.deleteDestinationTrash);
                dropdown.addOption("system-trash", text.deleteDestinationSystemTrash);
                dropdown.addOption("permanent", text.deleteDestinationPermanent);
                dropdown.setValue(value.deleteDestination).onChange(async (destination) => {
                    if (this._isDisposed()) return;
                    // Read from the render-time snapshot, which display() has
                    // already defaulted — `settings.value` can still be null
                    // when the very first load rejected.
                    const forcesConfirm = destination === "permanent"
                        && !value.confirmBeforeDelete;
                    try {
                        await this.settings.setValues({ deleteDestination: destination });
                        if (this._isDisposed()) return;
                        if (forcesConfirm) {
                            new Notice(text.confirmForcedOn, NOTICE_DURATION_MS);
                        }
                    } catch (error) {
                        this._reportError(error);
                    } finally {
                        // Choosing "permanent" turns confirmation back on, so the
                        // toggle below has to be redrawn to match what was saved.
                        if (!this._isDisposed() && generation === this._displayGeneration) {
                            this.display();
                        }
                    }
                });
            });

        new Setting(this.containerEl)
            .setName(text.confirmName)
            .setDesc(text.confirmDesc)
            .addToggle((toggle) => {
                const locked = value.deleteDestination === "permanent";
                toggle.setValue(value.confirmBeforeDelete)
                    .setDisabled(locked)
                    .onChange(async (confirm) => {
                        if (this._isDisposed()) return;
                        try {
                            await this.settings.setValues({ confirmBeforeDelete: confirm });
                            if (this._isDisposed()) return;
                            if (!confirm && this.settings.value.confirmBeforeDelete) {
                                new Notice(text.confirmForcedOn, NOTICE_DURATION_MS);
                                if (generation === this._displayGeneration) this.display();
                            }
                        } catch (error) {
                            this._reportError(error);
                        }
                    });
            });
    }

    _renderResetSection(text, generation) {
        new Setting(this.containerEl).setName(text.resetHeading).setHeading();
        new Setting(this.containerEl)
            .setName(text.resetName)
            .setDesc(text.resetDesc)
            .addButton((button) => {
                button.setButtonText(text.resetButton).setWarning().onClick(async () => {
                    if (this._isDisposed()) return;
                    // Drop queued text edits first: a debounced save landing
                    // after the reset would resurrect the value just cleared.
                    this._cancelQueuedSaves();
                    button.setDisabled(true);
                    try {
                        await this.settings.reset();
                        if (this._isDisposed()) return;
                        new Notice(text.resetDone, NOTICE_DURATION_MS);
                    } catch (error) {
                        this._reportError(error);
                    } finally {
                        // An orphan handler must not mutate a newly-rendered button.
                        if (!this._isDisposed() && generation === this._displayGeneration) {
                            this.display();
                        }
                    }
                });
            });
    }

    /**
     * Debounce a text-field save. Each save re-reads `data.json`, so writing
     * per keystroke would mean one read-modify-write cycle per character.
     */
    _queueSave(field, next) {
        if (this._isDisposed()) return;
        if (!this._pendingValues) this._pendingValues = new Map();
        this._pendingValues.set(field, next);
        const existing = this._pendingSaves.get(field);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this._pendingSaves.delete(field);
            if (this._pendingValues) this._pendingValues.delete(field);
            void this._commit({ [field]: next });
        }, TEXT_SAVE_DEBOUNCE_MS);
        this._pendingSaves.set(field, timer);
        // Validate immediately even though the save is deferred, so typing a
        // folder name shows "does not exist" until it actually resolves.
        this._refreshValidation({ ...this.settings.value, [field]: next });
    }

    _cancelQueuedSaves() {
        for (const timer of this._pendingSaves.values()) clearTimeout(timer);
        this._pendingSaves.clear();
        if (this._pendingValues) this._pendingValues.clear();
    }

    async _commit(patch) {
        if (this._isDisposed()) return;
        try {
            await this.settings.setValues(patch);
            if (this._isDisposed()) return;
            this._refreshValidation();
        } catch (error) {
            this._reportError(error);
        }
    }

    /**
     * Re-render the inline validation line. Uses the same {@link resolveScope}
     * the entry point uses, so the page never claims a configuration is fine
     * that a run would then refuse.
     */
    _refreshValidation(overrideValue) {
        if (this._isDisposed() || !this._validationEl) return;
        const text = this.settings.uiText.settingsText;
        const uiText = this.settings.uiText;
        const scope = resolveScope(
            overrideValue || this.settings.value,
            this.app && this.app.vault,
        );
        if (scope.ok) {
            this._validationEl.setText(text.validationOk);
            this._validationEl.removeClass("clear-unused-assets-validation-bad");
            this._validationEl.addClass("clear-unused-assets-validation-ok");
            return;
        }
        const lines = scope.errors.map(
            (problem) => `• ${localizedError(uiText, problem.key, problem.params)}`,
        );
        this._validationEl.setText([text.validationTitle, ...lines].join("\n"));
        this._validationEl.removeClass("clear-unused-assets-validation-ok");
        this._validationEl.addClass("clear-unused-assets-validation-bad");
    }

    _reportError(error) {
        if (this._isDisposed()) return;
        console.error("clear-unused-assets: failed to save settings", error);
        const raw = error instanceof Error ? error.message : String(error);
        const message = /^clear-unused-assets[:：]/.test(raw)
            ? raw
            : `clear-unused-assets: ${raw}`;
        new Notice(message, NOTICE_DURATION_MS);
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
//
// 其他模块会调用的接口：
//   - LANGUAGE_OPTIONS          语言配置表（main.js 兜底取 [0] 作为默认 uiText）
//   - ClearAssetsSettings       持久化设置（main.js 在 onload 中构造并 load()）
//   - ClearAssetsSettingTab     设置页 UI（main.js 传给 addSettingTab）
//   - bilingualError            未确定语言前的错误文案（load 失败时使用）
//   - localizedError            已确定语言后的错误文案（运行时错误使用）
//   - formatTemplate            占位符替换（main.js / confirmWindow.js 填参用）
//   - defaultSettings           默认配置快照（重置、以及读失败后的兜底值）
//   - SETTINGS_SCHEMA_VERSION   当前配置版本号，固定为 1
//   - DELETE_DESTINATIONS       合法的删除去向取值
//
// 范围校验相关的接口（resolveScope / isUnderFolder / parseExtensions 等）已挪到
// src/scope.js，需要的模块直接从那里 require，本文件不再转发。
//
// 用户操作触发的接口（导出以便单元测试直接构造相应类后调用）：
//   - ClearAssetsSettings.prototype.setLanguage(language)
//       由设置页语言下拉框 onChange 触发。
//   - ClearAssetsSettings.prototype.setValues(patch)
//       由设置页目录 / 扩展名 / 删除方式 / 确认开关的 onChange 触发。
//   - ClearAssetsSettings.prototype.reset()
//       由设置页 “重置所有设置 / Reset all settings” 按钮 onClick 触发。
//   - ClearAssetsSettings.prototype.repair()
//       由设置页 “修复配置文件 / Repair settings file” 按钮 onClick 触发。
//   - ClearAssetsSettingTab.prototype.display()
//       由 Obsidian 打开本插件设置页时触发（Obsidian 直接调用）。
//   - ClearAssetsSettingTab.prototype.hide()
//       由 Obsidian 关闭本插件设置页时触发，用于冲刷未落盘的文本编辑。
module.exports = {
    LANGUAGE_OPTIONS,
    ClearAssetsSettings,
    ClearAssetsSettingTab,
    bilingualError,
    localizedError,
    formatTemplate,
    defaultSettings,
    SETTINGS_SCHEMA_VERSION,
    DELETE_DESTINATIONS,
};

