/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LANGUAGE_OPTIONS,
    ClearAssetsSettings,
    SETTINGS_SCHEMA_VERSION,
    bilingualError,
    defaultSettings,
    localizedError,
    formatTemplate,
} = require("../src/settings");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
// 本文件只覆盖 “配置怎么读、怎么写、写坏了怎么办”：
//   - 双语 / 单语错误文案的渲染
//   - load：新装、正常、version 非法（<1 / 非整数）、version 过高
//   - load 失败后 value 仍是默认值（这是设置页能渲染出修复按钮的前提）
//   - 逐字段容错：单个字段脏数据只回退该字段
//   - 安全约束：permanent 强制打开确认
//   - save：盘上 version 非法 → 先备份再写；过高 → 拒写；repair() 可越过拒写
//   - 备份文件名带时间戳且不覆盖已有备份
//   - 写失败回滚、乱序写保护
// 扫描/删除逻辑在 ut/clear.test.js，入口分支在 ut/main.test.js。
// ---------------------------------------------------------------------------

const DATA_PATH = ".obsidian/plugins/clear-unused-assets/data.json";

/** 造一个已装好的插件：盘上有一份合法配置。 */
function bootWithSaved(saved) {
    const plugin = makeFakePlugin();
    plugin._seedData(saved);
    return plugin;
}

test("bilingualError 合并所有语言的模板并填参", () => {
    const msg = bilingualError("settingsVersionTooNew", { actual: "2", expected: 1 });
    assert.ok(msg.includes("clear-unused-assets：配置文件版本 2 高于插件支持的 1"), "zh line");
    assert.ok(
        msg.includes("clear-unused-assets: settings file version 2 is newer than this plugin supports (1)"),
        "en line",
    );
    assert.equal(msg.split("\n").length, LANGUAGE_OPTIONS.length);
});

test("localizedError 只用当前 uiText 里的模板", () => {
    const zh = LANGUAGE_OPTIONS.find((o) => o.value === "zh-CN");
    assert.equal(
        localizedError(zh, "includeFolderMissing", { path: "assets" }),
        "clear-unused-assets：清理目录不存在：assets。",
    );
});

test("formatTemplate 用 split/join，值里带 $& 也原样插入", () => {
    assert.equal(formatTemplate("a{x}b", { x: "$&" }), "a$&b");
});

test("两种语言的 notice / error / settingsText 键集合完全一致", () => {
    const [zh, en] = LANGUAGE_OPTIONS;
    for (const group of ["notice", "error", "settingsText"]) {
        assert.deepEqual(
            Object.keys(zh[group]).sort(),
            Object.keys(en[group]).sort(),
            `${group} 键集合应一致，否则 bilingualError 会漏一行`,
        );
    }
});

test("所有会进 Notice 的文案都带正确的语言相关前缀", () => {
    for (const option of LANGUAGE_OPTIONS) {
        const prefix = option.value === "zh-CN"
            ? "clear-unused-assets："
            : "clear-unused-assets: ";
        for (const [key, message] of Object.entries(option.notice)) {
            assert.ok(message.startsWith(prefix), `notice.${key} (${option.value})`);
        }
        for (const [key, message] of Object.entries(option.error)) {
            assert.ok(message.startsWith(prefix), `error.${key} (${option.value})`);
        }
    }
});

test("load: 新装（loadData 返回 null）时写入默认配置", async () => {
    const plugin = makeFakePlugin();
    const s = new ClearAssetsSettings(plugin);
    const v = await s.load();
    assert.deepEqual(v, defaultSettings());
    assert.equal(v.version, SETTINGS_SCHEMA_VERSION);
    assert.equal(v.language, "zh-CN");
    assert.equal(v.confirmBeforeDelete, true);
    // 新装要落盘，否则下次启动又是 “新装”，version 字段永远建立不起来。
    assert.deepEqual(plugin._dataStore.current, defaultSettings());
});

test("load: version 为 0 → 抛 illegal field 错误，且错误含双语提示", async () => {
    const plugin = bootWithSaved({ version: 0, language: "en" });
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load(), (err) => {
        assert.equal(err.message.split("\n").length, LANGUAGE_OPTIONS.length);
        assert.match(err.message, /非法/);
        assert.match(err.message, /illegal/);
        return true;
    });
});

test("load: version 缺失或非整数 → 同样按 illegal field 处理", async () => {
    for (const bad of [undefined, "1", 1.5, null]) {
        const plugin = bootWithSaved({ version: bad, language: "en" });
        const s = new ClearAssetsSettings(plugin);
        await assert.rejects(() => s.load(), /非法|illegal/);
    }
});

test("load: version 为 2 → 抛 “高于插件支持” 错误", async () => {
    const plugin = bootWithSaved({ version: 2, language: "en" });
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load(), /高于插件支持|newer than this plugin/);
});

test("load 失败后 value 是可用配置且 broken 为真 —— 设置页才渲染得出修复按钮", async () => {
    const plugin = bootWithSaved({ version: 99 });
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load());
    assert.deepEqual(s.value, defaultSettings());
    assert.equal(s.broken, true);
    assert.ok(s.loadError instanceof Error);
    // 读失败不能顺手改盘上的文件，否则用户的原始配置就没了。
    assert.deepEqual(plugin._dataStore.current, { version: 99 });
});

test("load 失败但其余字段可读时保留它们，修复不会顺手把配置清空", async () => {
    const plugin = bootWithSaved({
        version: 0,
        language: "en",
        includeFolders: "assets",
        extensions: "png",
    });
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load());
    assert.equal(s.value.language, "en");
    assert.equal(s.value.includeFolders, "assets");
    assert.equal(s.value.extensions, "png");
    await s.repair();
    assert.equal(plugin._dataStore.current.includeFolders, "assets", "修复后用户配置仍在");
    assert.equal(plugin._dataStore.current.version, SETTINGS_SCHEMA_VERSION);
});

test("load: 单个字段非法只回退该字段，其余保留", async () => {
    const plugin = bootWithSaved({
        version: 1,
        language: "xx-YY",
        includeFolders: "assets",
        excludeFolders: 42,
        extensions: "png",
        deleteDestination: "trash",
        confirmBeforeDelete: false,
    });
    const s = new ClearAssetsSettings(plugin);
    const v = await s.load();
    assert.equal(v.language, "zh-CN", "未知语言回退默认");
    assert.equal(v.includeFolders, "assets", "合法字段保留");
    assert.equal(v.excludeFolders, "", "非字符串回退默认");
    assert.equal(v.extensions, "png");
    assert.equal(v.deleteDestination, ".trash", "非法去向回退默认");
    assert.equal(v.confirmBeforeDelete, false);
});

test("load: confirmBeforeDelete 只有显式 false 才关，脏值一律按开", async () => {
    for (const dirty of ["false", 0, null, undefined]) {
        const plugin = bootWithSaved({ version: 1, confirmBeforeDelete: dirty });
        const s = new ClearAssetsSettings(plugin);
        const v = await s.load();
        assert.equal(v.confirmBeforeDelete, true, `${JSON.stringify(dirty)} 应视为开启`);
    }
});

test("load: permanent + 不确认 → 强制打开确认", async () => {
    const plugin = bootWithSaved({
        version: 1,
        deleteDestination: "permanent",
        confirmBeforeDelete: false,
    });
    const s = new ClearAssetsSettings(plugin);
    const v = await s.load();
    assert.equal(v.deleteDestination, "permanent");
    assert.equal(v.confirmBeforeDelete, true, "永久删除不允许无人值守");
});

test("load: loadData 本身抛错 → 记录 broken 并留下默认值，仍能走修复流程", async () => {
    const plugin = makeFakePlugin();
    plugin.loadData = async () => { throw new SyntaxError("Unexpected token }"); };
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load(), (err) => {
        assert.match(err.message, /读取配置文件失败/);
        assert.match(err.message, /Unexpected token/);
        assert.equal(err.message.split("\n").length, LANGUAGE_OPTIONS.length, "应是双语");
        return true;
    });
    assert.equal(s.broken, true, "否则设置页渲染不出修复按钮");
    assert.deepEqual(s.value, defaultSettings());
});

test("load: 文件存在但解析不了 → 按损坏处理，绝不当成新装覆盖掉", async () => {
    const plugin = makeFakePlugin();
    // Obsidian 的 loadData 读坏 JSON 时返回 undefined，和 “没有文件” 无法区分，
    // 所以必须再问一次文件系统。截断的 JSON 是最常见的同步事故产物。
    const truncated = '{"version":1,"language":"en","excludeFolders":"assets/keep-forev';
    plugin.app.vault.adapter.files.set(DATA_PATH, truncated);
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load(), /无法解析|cannot be parsed/);
    assert.equal(s.broken, true);
    assert.equal(
        plugin.app.vault.adapter.files.get(DATA_PATH),
        truncated,
        "读失败时绝不能写盘，否则用户的原始字节就没了",
    );
    // 修复时必须先把这份坏字节备份下来。
    await s.repair();
    const backups = [...plugin.app.vault.adapter.files.keys()]
        .filter((p) => p.endsWith(".json.bak"));
    assert.equal(backups.length, 1);
    assert.equal(plugin.app.vault.adapter.files.get(backups[0]), truncated);
});

test("broken 状态下的第一次写入即便盘上文件合法也要先备份", async () => {
    const plugin = makeFakePlugin();
    plugin._seedData({
        version: 1,
        language: "en",
        excludeFolders: "assets/keep-forever",
    });
    const s = new ClearAssetsSettings(plugin);
    // 模拟一次瞬时读失败（云盘占位文件、EBUSY）：内存里只剩默认值。
    const realLoad = plugin.loadData.bind(plugin);
    plugin.loadData = async () => { throw new Error("EBUSY"); };
    await assert.rejects(() => s.load());
    assert.equal(s.broken, true);
    plugin.loadData = realLoad;

    await s.repair();
    const backups = [...plugin.app.vault.adapter.files.keys()]
        .filter((p) => p.endsWith(".json.bak"));
    assert.equal(backups.length, 1, "内存值是重建出来的，盘上那份可能是唯一的真配置");
    assert.equal(
        JSON.parse(plugin.app.vault.adapter.files.get(backups[0])).excludeFolders,
        "assets/keep-forever",
    );
});

test("盘上有本插件不认识的字段时，写入要保留它 —— 版本策略的意义就在这", async () => {
    const plugin = makeFakePlugin();
    plugin._seedData({ version: 1, includeFolders: "assets", dryRun: true });
    const s = new ClearAssetsSettings(plugin);
    await s.load();
    await s.setLanguage("en");
    assert.equal(plugin._dataStore.current.dryRun, true, "旧版本应忽略而不是删掉新字段");
    assert.equal(plugin._dataStore.current.language, "en");
});

test("save 失败回滚时，回滚期间到达的新编辑不能被覆盖掉", async () => {
    const plugin = makeFakePlugin();
    plugin._seedData({ version: 1 });
    const s = new ClearAssetsSettings(plugin);
    await s.load();

    let releaseRead = null;
    const readGate = new Promise((resolve) => { releaseRead = resolve; });
    const realLoad = plugin.loadData.bind(plugin);
    plugin.saveData = async () => { throw new Error("EIO"); };
    // 只卡住回滚那一次读盘：_writeNow 自己的那次要放过去，否则写入根本走不到
    // 失败那一步，回滚分支也就测不到。
    let reads = 0;
    plugin.loadData = async () => {
        reads += 1;
        if (reads >= 2) await readGate;
        return realLoad();
    };

    // gen1 写失败 → 进入回滚，卡在读盘上。
    const failing = s.setValues({ extensions: "png" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(reads >= 2, "此时应已进入回滚的读盘");
    // 回滚读还没回来时，用户又改了一处。
    s.value = { ...s.value, excludeFolders: "assets/keep-forever" };
    s._saveGeneration += 1;
    releaseRead();
    await assert.rejects(() => failing, /EIO/);
    assert.equal(
        s.value.excludeFolders,
        "assets/keep-forever",
        "回滚只能覆盖它自己那一代的值",
    );
});

test("新装时的首次写入失败 → 仍然标记 broken，设置页才有话可说", async () => {
    const plugin = makeFakePlugin();
    plugin.saveData = async () => { throw new Error("EACCES"); };
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load(), /写入配置文件失败|failed to write/);
    assert.equal(s.broken, true, "否则设置页显示 “配置有效” 而入口却拒绝执行");
    assert.deepEqual(s.value, defaultSettings());
});

test("setLanguage: 未知语言无副作用，也不触发回调", async () => {
    const plugin = makeFakePlugin();
    let called = 0;
    const s = new ClearAssetsSettings(plugin, () => { called += 1; });
    await s.load();
    await s.setLanguage("fr-FR");
    assert.equal(called, 0);
    assert.equal(s.value.language, "zh-CN");
});

test("setLanguage: 合法语言写盘并触发 onChanged", async () => {
    const plugin = makeFakePlugin();
    let called = 0;
    const s = new ClearAssetsSettings(plugin, () => { called += 1; });
    await s.load();
    await s.setLanguage("en");
    assert.equal(called, 1);
    assert.equal(plugin._dataStore.current.language, "en");
});

test("setValues: 选 permanent 时确认开关被强制回到 true", async () => {
    const plugin = makeFakePlugin();
    const s = new ClearAssetsSettings(plugin);
    await s.load();
    await s.setValues({ confirmBeforeDelete: false });
    assert.equal(s.value.confirmBeforeDelete, false);
    await s.setValues({ deleteDestination: "permanent" });
    assert.equal(s.value.confirmBeforeDelete, true);
    assert.equal(plugin._dataStore.current.confirmBeforeDelete, true);
});

test("reset: 全部字段回默认并立刻落盘", async () => {
    const plugin = makeFakePlugin();
    const s = new ClearAssetsSettings(plugin);
    await s.load();
    await s.setValues({ includeFolders: "assets", extensions: "png", language: "en" });
    await s.reset();
    assert.deepEqual(s.value, defaultSettings());
    assert.deepEqual(plugin._dataStore.current, defaultSettings());
});

test("save: 盘上 version 非法 → 先备份成带时间戳的 .bak 再写入合法文件", async () => {
    const plugin = bootWithSaved({ version: 0, language: "en" });
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load());
    await s.repair();

    const backups = [...plugin.app.vault.adapter.files.keys()]
        .filter((p) => p.endsWith(".json.bak"));
    assert.equal(backups.length, 1, "应有且只有一份备份");
    assert.match(backups[0], /data\.[\dTZ-]+\.json\.bak$/);
    // 备份里必须是覆盖之前的字节，而不是刚写进去的新配置 —— 否则备份毫无意义。
    assert.deepEqual(JSON.parse(plugin.app.vault.adapter.files.get(backups[0])), {
        version: 0,
        language: "en",
    });
    assert.equal(plugin._dataStore.current.version, SETTINGS_SCHEMA_VERSION);
    assert.equal(s.broken, false, "修复后功能入口应恢复");
});

test("save: 连续两次坏写不会互相覆盖备份", async () => {
    const plugin = bootWithSaved({ version: 0, tag: "first" });
    const adapter = plugin.app.vault.adapter;
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load());
    await s.repair();

    // 模拟第二次又读到坏文件（例如别的窗口写坏了）。
    plugin._seedData({ version: 0, tag: "second" });
    await s.repair();

    const backups = [...adapter.files.keys()].filter((p) => p.endsWith(".json.bak"));
    assert.equal(backups.length, 2, "两次坏写应留下两份备份");
    const tags = backups.map((p) => JSON.parse(adapter.files.get(p)).tag).sort();
    assert.deepEqual(tags, ["first", "second"], "第一份备份不能被覆盖");
});

test("save: 盘上 version 更高 → 拒绝写入，data.json 不变，报错含实际版本号", async () => {
    const plugin = bootWithSaved({ version: 5, language: "en" });
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load());
    await assert.rejects(
        () => s.setValues({ includeFolders: "assets" }),
        (err) => {
            assert.match(err.message, /高于插件支持|newer than this plugin/);
            assert.match(err.message, /5/, "拒写理由要说清盘上是哪个版本");
            return true;
        },
    );
    assert.deepEqual(plugin._dataStore.current, { version: 5, language: "en" });
});

test("repair: 盘上 version 更高时也能写 —— 用户显式修复是唯一被允许的越权", async () => {
    const plugin = bootWithSaved({ version: 5, language: "en" });
    const s = new ClearAssetsSettings(plugin);
    await assert.rejects(() => s.load());
    await s.repair();
    assert.equal(plugin._dataStore.current.version, SETTINGS_SCHEMA_VERSION);
    const backups = [...plugin.app.vault.adapter.files.keys()]
        .filter((p) => p.endsWith(".json.bak"));
    assert.equal(backups.length, 1, "越权写入前必须留备份");
});

test("save 失败时回滚 value 并重新抛出", async () => {
    const plugin = makeFakePlugin();
    const s = new ClearAssetsSettings(plugin);
    await s.load();
    plugin.saveData = async () => { throw new Error("disk full"); };
    // 盘上已存的是 zh-CN，回滚后内存值应回到 zh-CN。
    plugin._seedData({ version: 1, language: "zh-CN" });
    await assert.rejects(() => s.setLanguage("en"), /disk full/);
    assert.equal(s.value.language, "zh-CN");
});

test("save: 写入串行化 —— 并发两次保存不会交错", async () => {
    const plugin = makeFakePlugin();
    const order = [];
    const s = new ClearAssetsSettings(plugin);
    await s.load();
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (d) => {
        order.push(`begin:${d.includeFolders}`);
        await new Promise((resolve) => setImmediate(resolve));
        order.push(`end:${d.includeFolders}`);
        return realSave(d);
    };
    await Promise.all([
        s.setValues({ includeFolders: "a" }),
        s.setValues({ includeFolders: "b" }),
    ]);
    // 串行意味着 begin/end 成对出现，不会是 begin,begin,end,end。
    for (let i = 0; i < order.length; i += 2) {
        assert.ok(order[i].startsWith("begin:"), `order[${i}] = ${order[i]}`);
        assert.ok(order[i + 1].startsWith("end:"), `order[${i + 1}] = ${order[i + 1]}`);
        assert.equal(order[i].slice(6), order[i + 1].slice(4));
    }
});

test("uiText: language 未初始化时兜底 LANGUAGE_OPTIONS[0]", () => {
    const plugin = makeFakePlugin();
    const s = new ClearAssetsSettings(plugin);
    assert.equal(s.uiText, LANGUAGE_OPTIONS[0]);
});
