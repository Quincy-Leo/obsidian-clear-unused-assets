/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// 内存版 Vault + Plugin，测试里替代 Obsidian 宿主
// ---------------------------------------------------------------------------
//
// 对应真实 API：
//   vault.getFiles()                    -> TFile[]
//   vault.getMarkdownFiles()            -> TFile[]
//   vault.getAbstractFileByPath(path)   -> TFile | TFolder | null（大小写敏感）
//   vault.trash(file, system)           -> Promise<void>
//   vault.delete(file, force?)          -> Promise<void>
//   fileManager.trashFile(file)         -> Promise<void>
//   adapter.exists(path)                -> Promise<boolean>
//   adapter.read(path)                  -> Promise<string>
//   adapter.write(path, data)           -> Promise<void>
//   metadataCache.resolvedLinks         -> Record<src, Record<dest, number>>
//
// 目录树用 Map<vaultPath, TFile | TFolder> 存。loadData / saveData 与
// adapter 共用同一个 data.json —— 真实 Obsidian 的 loadData 就是读
// `<manifest.dir>/data.json`，而备份逻辑走的是 adapter；两边分开存会让
// “先备份再覆盖” 的顺序在测试里根本观察不到。

const { TFile, TFolder } = require("obsidian");

const DATA_PATH = ".obsidian/plugins/clear-unused-assets/data.json";

function makeFakeAdapter() {
    const files = new Map();
    return {
        files,
        async exists(p) { return files.has(p); },
        async read(p) {
            if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
            return files.get(p);
        },
        async write(p, data) { files.set(p, String(data)); },
        async remove(p) {
            if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
            files.delete(p);
        },
    };
}

/**
 * 用 "a/b/c.png" 这样的路径列表搭出一棵目录树。
 *
 * 文件用真正的 TFile 实例，并挂上 parent / stat，目录用真正的 TFolder 并把
 * children 填好 —— 这三点都是刻意的：clear.js 之后会按 `instanceof TFile` 判
 * 类型、按 `stat.size` 报大小、按 children 递归遍历，fixture 偷懒就会让正确
 * 的实现看起来是错的。
 *
 * @param {string[]} paths 文件路径；中间目录自动补齐。
 */
function makeFakeVaultTree(paths) {
    const entries = new Map();
    const root = new TFolder();
    root.path = "/";
    root.name = "";
    entries.set("/", root);

    /** 取（必要时创建）某个目录，并把它挂到父目录的 children 上。 */
    function folderAt(path) {
        if (path === "") return root;
        if (entries.has(path)) return entries.get(path);
        const folder = new TFolder();
        folder.path = path;
        const cut = path.lastIndexOf("/");
        folder.name = cut === -1 ? path : path.slice(cut + 1);
        folder.parent = folderAt(cut === -1 ? "" : path.slice(0, cut));
        folder.parent.children.push(folder);
        entries.set(path, folder);
        return folder;
    }

    let size = 100;
    for (const filePath of paths) {
        const cut = filePath.lastIndexOf("/");
        const fileName = cut === -1 ? filePath : filePath.slice(cut + 1);
        const parent = folderAt(cut === -1 ? "" : filePath.slice(0, cut));
        const dot = fileName.lastIndexOf(".");
        const file = new TFile();
        file.path = filePath;
        file.name = fileName;
        file.basename = dot > 0 ? fileName.slice(0, dot) : fileName;
        file.extension = dot > 0 ? fileName.slice(dot + 1) : "";
        file.parent = parent;
        file.stat = { size, mtime: 1, ctime: 1 };
        size += 1;
        parent.children.push(file);
        entries.set(filePath, file);
    }
    return entries;
}

function makeFakePlugin(overrides = {}) {
    const adapter = overrides.adapter || makeFakeAdapter();
    // `contents` doubles as a path list: a test that gives a file text does not
    // also have to remember to list its path.
    const contents = overrides.contents || {};
    const paths = overrides.paths
        ? [...new Set(overrides.paths.concat(Object.keys(contents)))]
        : Object.keys(contents);
    const entries = overrides.entries || makeFakeVaultTree(paths);
    for (const [path, text] of Object.entries(contents)) {
        const entry = entries.get(path);
        if (entry) entry.__contents = text;
    }
    const dataStore = { current: null };
    const trashed = [];
    const deleted = [];
    const metadataListeners = {};
    const plugin = {
        manifest: {
            id: "clear-unused-assets",
            dir: ".obsidian/plugins/clear-unused-assets",
        },
        app: {
            vault: {
                adapter,
                getFiles() {
                    return [...entries.values()].filter((e) => e instanceof TFile);
                },
                getMarkdownFiles() {
                    return this.getFiles().filter((f) => f.extension === "md");
                },
                // 真实实现是 fileMap 的精确查表，大小写敏感 —— 这里保持一致。
                getAbstractFileByPath(p) {
                    return entries.has(p) ? entries.get(p) : null;
                },
                async trash(file, system) { trashed.push({ path: file.path, system }); },
                async delete(file, _force) { deleted.push(file.path); },
                async read(file) {
                    // 读失败要能被显式构造出来（clear.js 的 fail-closed 分支就
                    // 靠它），但没给内容的文件按空文件处理 —— 否则任何只列了
                    // 路径的 fixture 都会意外触发中止。
                    if (file.__readError) throw new Error(file.__readError);
                    return typeof file.__contents === "string" ? file.__contents : "";
                },
                async cachedRead(file) { return this.read(file); },
            },
            fileManager: {
                async trashFile(file) { trashed.push({ path: file.path, system: "setting" }); },
            },
            metadataCache: {
                resolvedLinks: overrides.resolvedLinks || {},
                unresolvedLinks: overrides.unresolvedLinks || {},
                getFileCache(file) {
                    return overrides.fileCacheResolver
                        ? overrides.fileCacheResolver(file)
                        : {};
                },
                getFirstLinkpathDest(linkpath, _sourcePath) {
                    if (!linkpath) return null;
                    return overrides.linkResolver
                        ? overrides.linkResolver(linkpath)
                        : (entries.get(linkpath) || null);
                },
                on(event, cb) {
                    metadataListeners[event] = (metadataListeners[event] || []).concat(cb);
                    return { unload() {} };
                },
            },
            workspace: {
                getLeavesOfType: () => [],
                onLayoutReady: (cb) => cb(),
            },
        },
        addCommand(spec) { this._command = spec; return spec; },
        addRibbonIcon(icon, title, cb) {
            this._ribbon = { icon, title };
            this._ribbonCb = cb;
            return { setAttribute(k, v) { plugin._ribbon[k] = v; } };
        },
        addSettingTab(tab) { this._settingTab = tab; },
        removeCommand(_id) { this._command = null; },
        registerEvent(_ref) {},
        // loadData / saveData 直写 adapter 里的 data.json：真实 Obsidian 就是
        // 这么落盘的，而备份逻辑读的是 adapter。两边分开存会让
        // “先备份再覆盖” 这个顺序在测试里根本观察不到。
        async loadData() {
            if (!adapter.files.has(DATA_PATH)) return dataStore.current;
            try {
                return JSON.parse(adapter.files.get(DATA_PATH));
            } catch (_) {
                // 真实实现读坏 JSON 时返回 undefined。
                return undefined;
            }
        },
        async saveData(d) {
            dataStore.current = JSON.parse(JSON.stringify(d));
            adapter.files.set(DATA_PATH, JSON.stringify(d, undefined, 2));
        },
        // Test hooks.
        _dataStore: dataStore,
        _entries: entries,
        _trashed: trashed,
        _deleted: deleted,
        /** 触发 metadataCache 事件，例如索引建完时的 "resolved"。 */
        _fireMetadata(event) {
            for (const cb of metadataListeners[event] || []) cb();
        },
        /** 预置盘上的 data.json，两边保持一致。 */
        _seedData(value) {
            dataStore.current = value === undefined ? null : value;
            if (value === undefined) adapter.files.delete(DATA_PATH);
            else adapter.files.set(DATA_PATH, JSON.stringify(value, undefined, 2));
        },
    };
    return plugin;
}

module.exports = { makeFakeAdapter, makeFakePlugin, makeFakeVaultTree, DATA_PATH };
