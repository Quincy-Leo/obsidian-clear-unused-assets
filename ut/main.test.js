/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const boot = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const ClearUnusedAssetsPlugin = require("../src/main");
const { ClearAssetsSettingTab } = require("../src/settings");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
// main.js 的入口是 clearUnusedAssets()，命令和 ribbon 共用它。为了隔离
// clear.js / confirmWindow.js，这里把 plugin.clearJob 换成可控 stub，专测
// main.js 自己的分支与 Notice：
//   - 已在运行 → 直接返回（命令 + ribbon 连点只能启动一个）
//   - 配置读失败 → 只弹修复提示，不扫描
//   - 配置非法（目录不存在等）→ 一次性列出全部问题，不扫描
//   - 索引未就绪 → 弹 cacheNotReady
//   - 扫描 aborted → 按 abortReason 弹对应文案
//   - 无候选 → 弹 nothing
//   - 关闭确认 → 直接删全部候选
//   - 开启确认 → 走 modal，取消/空选 → 弹 cancelled
//   - 删完 → 弹计数，完整清单进 console
//   - 抛已本地化错误 → 不重复前缀；抛裸错误 → 手动加前缀
//   - onunload 后的续跑不产生任何副作用
// 目录匹配与配置读写分别在 ut/scope.test.js、ut/settings.test.js。
// ---------------------------------------------------------------------------

const OK_SCAN = { candidates: [], total: 0, aborted: false, abortReason: null, cancelled: false };

/**
 * 直接 new 出插件实例，绕过 Obsidian 加载器，再把 clearJob 换成 stub。
 * @param {object} [options]
 * @param {object} [options.saved] 预置的盘上配置
 * @param {string[]} [options.paths] 预置的 vault 目录树
 * @param {object} [options.job] 覆盖 clearJob 的字段
 */
async function bootPlugin(options = {}) {
    const fake = makeFakePlugin({ paths: options.paths || [] });
    if (options.saved !== undefined) fake._seedData(options.saved);
    const plugin = new ClearUnusedAssetsPlugin(fake.app, fake.manifest);
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    // 用 fake 的记录版注册方法，这样命令名 / ribbon 提示的变化看得见。
    plugin.addRibbonIcon = fake.addRibbonIcon.bind(fake);
    plugin.__fake = fake;
    await plugin.onload();
    plugin.clearJob = {
        calls: { run: 0, deleteSelected: 0 },
        ready: true,
        scan: OK_SCAN,
        deletion: { deleted: [], kept: [], failed: [], destinationUsed: ".trash", cancelled: false },
        isCacheReady() { return this.ready; },
        async run(scope) {
            this.calls.run += 1;
            this.lastScope = scope;
            return typeof this.scan === "function" ? this.scan() : this.scan;
        },
        async deleteSelected(paths, opts) {
            this.calls.deleteSelected += 1;
            this.lastPaths = paths;
            this.lastOptions = opts;
            return typeof this.deletion === "function" ? this.deletion(paths) : this.deletion;
        },
        cancel() { this.cancelled = true; },
        ...(options.job || {}),
    };
    boot.resetNotices();
    return plugin;
}

/** 把 confirmWindow 的选择结果固定下来，避免测试依赖真实弹窗。 */
function stubConfirm(plugin, result) {
    plugin._selectForDeletion = async () => result;
}

function messages() {
    return boot.noticeLog.map((n) => n.message);
}

test("onload: 注册命令与 ribbon，且两者复用同一个入口函数", async () => {
    const fake = makeFakePlugin();
    const plugin = new ClearUnusedAssetsPlugin(fake.app, fake.manifest);
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    let commandSpec = null;
    let ribbon = null;
    let ribbonCb = null;
    let settingTab = null;
    plugin.addCommand = (spec) => { commandSpec = spec; return spec; };
    plugin.addRibbonIcon = (icon, title, cb) => {
        ribbon = { icon, title, attrs: {} };
        ribbonCb = cb;
        return { setAttribute(k, v) { ribbon.attrs[k] = v; } };
    };
    plugin.addSettingTab = (tab) => { settingTab = tab; };
    await plugin.onload();
    assert.equal(commandSpec.id, "clear-unused-assets");
    assert.equal(commandSpec.name, "清理未被引用的附件");
    assert.equal(commandSpec.callback, ribbonCb, "命令与 ribbon 必须是同一个函数");
    assert.equal(ribbon.icon, "image-file", "图标 ID 是需求指定的");
    assert.equal(ribbon.title, "清理未被引用的附件");
    assert.ok(settingTab instanceof ClearAssetsSettingTab, "设置页是唯一的修复入口");
});

test("配置读坏时 onload 仍然注册设置页，并且当场就弹出原因", async () => {
    const fake = makeFakePlugin();
    fake._seedData({ version: 0 });
    const plugin = new ClearUnusedAssetsPlugin(fake.app, fake.manifest);
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    let settingTab = null;
    plugin.addSettingTab = (tab) => { settingTab = tab; };
    boot.resetNotices();
    await plugin.onload();
    assert.ok(settingTab instanceof ClearAssetsSettingTab, "没有设置页就没法修复");
    assert.equal(boot.noticeLog.length, 1, "读失败必须当场告知用户");
    assert.match(boot.noticeLog[0].message, /非法/);
});

test("切换语言后命令名与 ribbon 提示都重新本地化", async () => {
    const plugin = await bootPlugin();
    await plugin.settingsStore.setLanguage("en");
    assert.equal(plugin.clearCommand.name, "Clear unused assets");
    assert.equal(plugin.__fake._ribbon["aria-label"], "Clear unused assets");
    await plugin.settingsStore.setLanguage("zh-CN");
    assert.equal(plugin.clearCommand.name, "清理未被引用的附件");
    assert.equal(plugin.__fake._ribbon["aria-label"], "清理未被引用的附件");
});

test("已经在运行时立刻返回，什么 Notice 也不弹", async () => {
    const plugin = await bootPlugin();
    plugin.clearing = true;
    await plugin.clearUnusedAssets();
    assert.equal(boot.noticeLog.length, 0);
    assert.equal(plugin.clearJob.calls.run, 0);
});

test("配置读失败时入口拒绝执行，只弹修复提示", async () => {
    const plugin = await bootPlugin({ saved: { version: 0 } });
    assert.ok(plugin.settingsError, "读失败应记录在 settingsError 上");
    boot.resetNotices();
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearJob.calls.run, 0, "配置不可用时不能扫描");
    assert.equal(boot.noticeLog.length, 1);
    assert.match(boot.noticeLog[0].message, /配置文件不可用/);
});

test("配置非法（目录不存在）→ 一次性列出全部问题且不扫描", async () => {
    const plugin = await bootPlugin({ paths: ["assets/a.png"] });
    await plugin.settingsStore.setValues({
        includeFolders: "missing-a\nmissing-b",
    });
    boot.resetNotices();
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearJob.calls.run, 0);
    assert.equal(boot.noticeLog.length, 1);
    const lines = boot.noticeLog[0].message.split("\n");
    assert.equal(lines.length, 2, "两行错误配置应各报一条");
    assert.ok(lines.every((l) => /清理目录不存在/.test(l)));
});

test("索引未就绪 → 弹 cacheNotReady，不扫描", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.ready = false;
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearJob.calls.run, 0);
    assert.match(messages().join("\n"), /仍在建立索引/);
});

test("扫描 aborted: read-failed → 报出无法读取的文件名", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = {
        candidates: [], total: 10, aborted: true, cancelled: false,
        abortReason: { kind: "read-failed", path: "board.canvas" },
    };
    await plugin.clearUnusedAssets();
    const all = messages().join("\n");
    assert.match(all, /无法读取 board\.canvas/);
    assert.equal(plugin.clearJob.calls.deleteSelected, 0);
});

test("扫描 aborted: parse-failed / vault-changed / suspicious 各有专属文案", async () => {
    const cases = [
        [{ kind: "parse-failed", path: "x.canvas" }, /无法解析 x\.canvas/],
        [{ kind: "vault-changed", path: "" }, /仓库发生变化/],
        [{ kind: "suspicious", path: "" }, /扫描结果异常/],
    ];
    for (const [abortReason, pattern] of cases) {
        const plugin = await bootPlugin();
        plugin.clearJob.scan = {
            candidates: [], total: 20, aborted: true, cancelled: false, abortReason,
        };
        await plugin.clearUnusedAssets();
        assert.match(messages().join("\n"), pattern);
    }
});

test("没有候选 → 弹 nothing，不进删除", async () => {
    const plugin = await bootPlugin();
    await plugin.clearUnusedAssets();
    assert.match(messages().join("\n"), /没有未被引用的附件/);
    assert.equal(plugin.clearJob.calls.deleteSelected, 0);
});

test("关闭确认 → 直接删除全部候选，不开弹窗，并按设置的去向删", async () => {
    const plugin = await bootPlugin();
    // 故意选一个不是默认值的去向，否则写死 ".trash" 也能过。
    await plugin.settingsStore.setValues({
        confirmBeforeDelete: false,
        deleteDestination: "system-trash",
    });
    plugin.clearJob.scan = {
        candidates: [{ path: "a.png", flags: [] }, { path: "b.png", flags: [] }],
        total: 2, aborted: false, abortReason: null, cancelled: false,
    };
    plugin.clearJob.deletion = {
        deleted: ["a.png", "b.png"], kept: [], failed: [],
        destinationUsed: "system-trash", cancelled: false,
    };
    boot.resetNotices();
    await plugin.clearUnusedAssets();
    assert.deepEqual(plugin.clearJob.lastPaths, ["a.png", "b.png"]);
    assert.equal(plugin.clearJob.lastOptions.destination, "system-trash");
    assert.equal(boot.noticeLog.length, 2, "一次运行只应有 “开始” 和 “结果” 两条");
    assert.match(messages().join("\n"), /已删除 2 个附件/);
});

test("确认弹窗返回 null（取消）→ 弹 cancelled，不删除", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = {
        candidates: [{ path: "a.png", flags: [] }],
        total: 1, aborted: false, abortReason: null, cancelled: false,
    };
    stubConfirm(plugin, null);
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearJob.calls.deleteSelected, 0);
    assert.match(messages().join("\n"), /已取消/);
});

test("确认弹窗里全部取消勾选 → 同样按取消处理", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = {
        candidates: [{ path: "a.png", flags: [] }],
        total: 1, aborted: false, abortReason: null, cancelled: false,
    };
    stubConfirm(plugin, []);
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearJob.calls.deleteSelected, 0);
    assert.match(messages().join("\n"), /已取消/);
});

test("只删除用户勾选的那些路径", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = {
        candidates: [
            { path: "a.png", flags: [] },
            { path: "b.png", flags: [] },
            { path: "c.png", flags: ["duplicate-basename"] },
        ],
        total: 3, aborted: false, abortReason: null, cancelled: false,
    };
    stubConfirm(plugin, ["a.png", "c.png"]);
    plugin.clearJob.deletion = {
        deleted: ["a.png"], kept: [{ path: "c.png", reason: "now-referenced" }],
        failed: [], destinationUsed: ".trash", cancelled: false,
    };
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => { logged.push(args); };
    try {
        await plugin.clearUnusedAssets();
    } finally {
        console.log = realLog;
    }
    assert.deepEqual(plugin.clearJob.lastPaths, ["a.png", "c.png"]);
    const all = messages().join("\n");
    assert.match(all, /已删除 1 个附件（保留 1，失败 0）/);
    // 完整清单必须进 console —— 这是这类破坏性操作唯一的留痕。
    const deletedLog = logged.find((args) => String(args[0]).includes("deleted"));
    assert.deepEqual(deletedLog[1], ["a.png"]);
    const keptLog = logged.find((args) => String(args[0]).includes("kept"));
    assert.deepEqual(keptLog[1], [{ path: "c.png", reason: "now-referenced" }]);
});

test("删除结果里的失败数量也如实上报", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = {
        candidates: [{ path: "a.png", flags: [] }, { path: "b.png", flags: [] }],
        total: 2, aborted: false, abortReason: null, cancelled: false,
    };
    stubConfirm(plugin, ["a.png", "b.png"]);
    plugin.clearJob.deletion = {
        deleted: ["a.png"], kept: [],
        failed: [{ path: "b.png", error: "EPERM" }],
        destinationUsed: ".trash", cancelled: false,
    };
    await plugin.clearUnusedAssets();
    assert.match(messages().join("\n"), /已删除 1 个附件（保留 0，失败 1）/);
});

test("run 抛已本地化错误 → 不重复 clear-unused-assets 前缀", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = () => {
        throw new Error("clear-unused-assets：清理功能尚未实现。");
    };
    await plugin.clearUnusedAssets();
    const message = messages().pop();
    assert.equal(message, "clear-unused-assets：清理功能尚未实现。");
    assert.equal(message.match(/clear-unused-assets/g).length, 1);
});

test("run 抛裸错误 → 手动加 clear-unused-assets: 前缀", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = () => { throw new Error("boom"); };
    await plugin.clearUnusedAssets();
    assert.equal(messages().pop(), "clear-unused-assets: boom");
});

test("出错后 clearing 复位，可再次触发", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = () => { throw new Error("boom"); };
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearing, false);
    plugin.clearJob.scan = OK_SCAN;
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearJob.calls.run, 2);
});

test("扫描期间卸载 → 不删除、不弹任何结果 Notice", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = () => {
        plugin.onunload();
        return {
            candidates: [{ path: "a.png", flags: [] }],
            total: 1, aborted: false, abortReason: null, cancelled: false,
        };
    };
    let confirmOpened = false;
    plugin._selectForDeletion = async () => { confirmOpened = true; return ["a.png"]; };
    await plugin.clearUnusedAssets();
    assert.equal(confirmOpened, false, "卸载后不能再弹确认框");
    assert.equal(boot.noticeLog.length, 1, "只应留下开始扫描那一条");
    assert.match(boot.noticeLog[0].message, /正在扫描/);
});

test("确认期间卸载 → 已勾选的文件也不再删除", async () => {
    const plugin = await bootPlugin();
    // onunload 会把 plugin.clearJob 置空，所以先留一份引用用于断言。
    const job = plugin.clearJob;
    job.scan = {
        candidates: [{ path: "a.png", flags: [] }],
        total: 1, aborted: false, abortReason: null, cancelled: false,
    };
    plugin._selectForDeletion = async () => {
        plugin.onunload();
        return ["a.png"];
    };
    await plugin.clearUnusedAssets();
    assert.equal(job.calls.deleteSelected, 0);
});

test("onunload: 幂等，并会关闭还开着的确认弹窗", async () => {
    const plugin = await bootPlugin();
    let closed = 0;
    plugin.confirmModal = { close() { closed += 1; } };
    plugin.onunload();
    plugin.onunload();
    assert.equal(closed, 1, "重复 onunload 不应重复关闭");
    assert.equal(plugin.clearJob, null);
});

test("扫描拿到的 scope 已解析成具体范围", async () => {
    const plugin = await bootPlugin({ paths: ["assets/a.png", "assets/keep/b.png"] });
    await plugin.settingsStore.setValues({
        includeFolders: "assets",
        excludeFolders: "assets/keep",
    });
    boot.resetNotices();
    await plugin.clearUnusedAssets();
    assert.deepEqual(plugin.clearJob.lastScope.includeFolders, ["assets"]);
    assert.deepEqual(plugin.clearJob.lastScope.excludeFolders, ["assets/keep"]);
    assert.ok(plugin.clearJob.lastScope.extensions.includes("png"));
});

// ---------------------------------------------------------------------------
// 下面这些是审查里暴露出来的坑，单独钉住
// ---------------------------------------------------------------------------

test("真实 clear.js + 真实 main.js：索引未就绪时如实提示，而不是静默无反应", async () => {
    // 不换 stub。fake 的 metadataCache 是空的，等于插件刚启动、索引还没建完。
    const fake = makeFakePlugin({ paths: ["assets/a.png", "note.md"] });
    const plugin = new ClearUnusedAssetsPlugin(fake.app, fake.manifest);
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    await plugin.onload();
    boot.resetNotices();
    // 走用户真正点到的那条路径：命令 / ribbon 的回调是 void 掉 promise 的。
    plugin.clearAssets();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(messages().join("\n"), /仍在建立索引/);
    assert.equal(plugin.clearing, false);
});

test("真实 clear.js + 真实 main.js：入口抛错也要弹 Notice，不能变成静默的未捕获拒绝", async () => {
    const fake = makeFakePlugin({ paths: ["assets/a.png", "note.md"] });
    const plugin = new ClearUnusedAssetsPlugin(fake.app, fake.manifest);
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    await plugin.onload();
    fake._fireMetadata("resolved");
    // 让预检阶段抛一个裸错误：命令回调 void 掉了 promise，除了 catch 没人会报它。
    fake.app.vault.getFiles = () => { throw new Error("boom"); };
    boot.resetNotices();
    plugin.clearAssets();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages().pop(), "clear-unused-assets: boom");
    assert.equal(plugin.clearing, false, "抛错后必须复位，否则插件永久卡死");
});

test("真实 clear.js + 真实 main.js：索引就绪后走完整条流程并真的删掉文件", async () => {
    const fake = makeFakePlugin({
        contents: { "note.md": "![[assets/used.png]]" },
        paths: ["assets/used.png", "assets/unused.png"],
    });
    const plugin = new ClearUnusedAssetsPlugin(fake.app, fake.manifest);
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    await plugin.onload();
    fake._fireMetadata("resolved");
    await plugin.settingsStore.setValues({ confirmBeforeDelete: false });
    boot.resetNotices();
    await plugin.clearUnusedAssets();
    assert.deepEqual(fake._trashed.map((t) => t.path), ["assets/unused.png"]);
    assert.match(messages().join("\n"), /已删除 1 个附件/);
});

test("store 自己变 broken（保存时发现盘上版本更高）后入口也要拒绝", async () => {
    const plugin = await bootPlugin();
    // 模拟别的窗口把 data.json 写成了更高版本。
    plugin.__fake._seedData({ version: 9 });
    await assert.rejects(() => plugin.settingsStore.setValues({ extensions: "png" }));
    assert.equal(plugin.settingsStore.broken, true);
    boot.resetNotices();
    await plugin.clearUnusedAssets();
    assert.equal(plugin.clearJob.calls.run, 0);
    assert.match(messages().join("\n"), /配置文件不可用/);
});

test("suspicious 中止的计数取自 abortReason，而不是被清空的候选列表", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = {
        candidates: [], total: 20, aborted: true, cancelled: false,
        abortReason: { kind: "suspicious", candidates: 19, total: 20 },
    };
    await plugin.clearUnusedAssets();
    assert.match(messages().join("\n"), /19\/20 个附件都没有被引用/);
});

test("未知的中止原因按 “读不了” 处理，不会渲染出 undefined", async () => {
    const plugin = await bootPlugin();
    plugin.clearJob.scan = {
        candidates: [], total: 5, aborted: true, cancelled: false,
        abortReason: { kind: "some-future-kind" },
    };
    await plugin.clearUnusedAssets();
    const message = messages().pop();
    assert.match(message, /无法读取/);
    assert.ok(!message.includes("undefined"), message);
});

test("删除去向被回退时如实告知用户", async () => {
    const plugin = await bootPlugin();
    await plugin.settingsStore.setValues({ deleteDestination: "system-trash" });
    plugin.clearJob.scan = {
        candidates: [{ path: "a.png", flags: [] }],
        total: 1, aborted: false, abortReason: null, cancelled: false,
    };
    stubConfirm(plugin, ["a.png"]);
    plugin.clearJob.deletion = {
        deleted: ["a.png"], kept: [], failed: [],
        destinationUsed: ".trash", cancelled: false,
    };
    boot.resetNotices();
    await plugin.clearUnusedAssets();
    const message = messages().pop();
    assert.match(message, /已删除 1 个附件/);
    assert.match(message, /从 system-trash 回退为 \.trash/);
});

test("删除中途卸载：不弹 Notice，但已删掉的文件仍要落到 console", async () => {
    const plugin = await bootPlugin();
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => { logged.push(args); };
    try {
        plugin.clearJob.scan = {
            candidates: [{ path: "a.png", flags: [] }, { path: "b.png", flags: [] }],
            total: 2, aborted: false, abortReason: null, cancelled: false,
        };
        stubConfirm(plugin, ["a.png", "b.png"]);
        plugin.clearJob.deletion = () => {
            plugin.onunload();
            return {
                deleted: ["a.png"], kept: [], failed: [],
                destinationUsed: ".trash", cancelled: true,
            };
        };
        boot.resetNotices();
        await plugin.clearUnusedAssets();
    } finally {
        console.log = realLog;
    }
    assert.equal(boot.noticeLog.length, 1, "只应留下开始扫描那一条");
    const deletedLog = logged.find((args) => String(args[0]).includes("deleted"));
    assert.ok(deletedLog, "已删除的文件必须留下记录");
    assert.deepEqual(deletedLog[1], ["a.png"]);
});

test("卸载后到达的语言切换回调不再重新注册命令", async () => {
    const plugin = await bootPlugin();
    let addCalls = 0;
    plugin.addCommand = (spec) => { addCalls += 1; return spec; };
    plugin.onunload();
    plugin.refreshLocalizedEntryLabels();
    assert.equal(addCalls, 0, "卸载后重新注册会留下一个永远无效的命令面板条目");
    assert.equal(plugin.clearCommand, null);
});

test("开启确认时走真实弹窗：勾选结果与去向都如实传给删除", async () => {
    const plugin = await bootPlugin();
    const job = plugin.clearJob;
    await plugin.settingsStore.setValues({ deleteDestination: "system-trash" });
    job.scan = {
        candidates: [
            { path: "a.png", flags: [] },
            { path: "b.png", flags: [] },
            { path: "c.png", flags: ["text-only-match"] },
        ],
        total: 3, aborted: false, abortReason: null, cancelled: false,
    };
    job.deletion = {
        deleted: ["a.png"], kept: [], failed: [],
        destinationUsed: "system-trash", cancelled: false,
    };
    // 不替换 _selectForDeletion —— 这里要测的正是 main ↔ confirmWindow 的交接。
    const pending = plugin.clearUnusedAssets();
    await new Promise((resolve) => setImmediate(resolve));
    const modal = plugin.confirmModal;
    assert.ok(modal, "弹窗引用必须交到 plugin 上");
    // 弹窗要按当前设置显示去向，而不是写死的默认值。
    const destinationEl = modal.contentEl.children.find(
        (el) => el.classes instanceof Set && el.classes.has("clear-unused-assets-destination"),
    );
    assert.equal(destinationEl.text, "去向：系统回收站");
    // 取消勾选 b.png，c.png 因为有 flags 本来就没勾。
    const boxes = [];
    const walk = (el) => {
        for (const child of el.children || []) {
            if (child.tag === "input" && child.type === "checkbox") boxes.push(child);
            if (child.children) walk(child);
        }
    };
    walk(modal.contentEl);
    boxes[1].checked = false;
    boxes[1].__fire("change");
    // 点弹窗底部的删除按钮。
    const deleteButton = modal.modalEl.children.find(
        (el) => el.children && el.children.some((c) => typeof c.setButtonText === "function"),
    ).children[0];
    deleteButton._onClick();
    await pending;
    assert.deepEqual(job.lastPaths, ["a.png"]);
    assert.equal(job.lastOptions.destination, "system-trash");
    assert.equal(plugin.confirmModal, null, "resolve 后引用要撤掉");
});

test("开启确认时走真实弹窗：卸载会把它关掉且不删除任何文件", async () => {
    const plugin = await bootPlugin();
    const job = plugin.clearJob;
    job.scan = {
        candidates: [{ path: "a.png", flags: [] }],
        total: 1, aborted: false, abortReason: null, cancelled: false,
    };
    const pending = plugin.clearUnusedAssets();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(plugin.confirmModal, "弹窗引用必须交到 plugin 上，否则卸载时关不掉");
    plugin.onunload();
    await pending;
    assert.equal(job.calls.deleteSelected, 0);
    assert.equal(plugin.confirmModal, null, "resolve 后引用要撤掉");
});
