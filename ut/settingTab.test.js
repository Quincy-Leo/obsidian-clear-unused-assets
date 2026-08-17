/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const boot = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ClearAssetsSettings,
    ClearAssetsSettingTab,
    DELETE_DESTINATIONS,
    LANGUAGE_OPTIONS,
    defaultSettings,
} = require("../src/settings");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
// 设置页有两条容易写坏的性质，这里重点覆盖：
//   1. data.json 读坏时页面仍然要渲染出全部控件 + 修复按钮 —— 否则用户没有
//      任何入口能救回配置（这正是 “插件仍加载但功能入口拒绝执行” 的前提）
//   2. 校验结果就地显示在字段旁边，而不是每敲一个字弹一个 Notice；文本字段
//      的落盘是防抖的，切走页面（hide）时要冲刷掉未落盘的编辑
// 另外覆盖：选 permanent 会强制打开并禁用确认开关、重置按钮、dispose 后不再动 DOM。
// ---------------------------------------------------------------------------

/** 造一个已 load 过的 settings store + 挂好的设置页。 */
async function bootTab(options = {}) {
    const fake = makeFakePlugin({ paths: options.paths || [] });
    if (options.saved !== undefined) fake._seedData(options.saved);
    const store = new ClearAssetsSettings(fake, () => {});
    try {
        await store.load();
    } catch (_) {
        // 读失败是被测场景之一：load 内部已经把默认值放进 value 了。
    }
    const tab = new ClearAssetsSettingTab(fake.app, store);
    boot.resetNotices();
    return { fake, store, tab };
}

/** 深度收集设置页里的控件（Setting 会把组件塞进 components）。 */
function settings(tab) {
    return tab.containerEl.children.filter((el) => Array.isArray(el.components));
}

function componentsOf(tab) {
    return settings(tab).flatMap((s) => s.components);
}

function findByText(tab, text) {
    return componentsOf(tab).find((c) => c.text === text);
}

/** 按 Setting 的名字取它的第一个控件 —— 比按控件形状猜更稳。 */
function controlNamed(tab, name) {
    const setting = settings(tab).find((s) => s.name === name);
    return setting ? setting.components[0] : null;
}

function findEl(el, cls, out = []) {
    for (const child of el.children || []) {
        if (child.classes instanceof Set && child.classes.has(cls)) out.push(child);
        if (child.children) findEl(child, cls, out);
        if (child.descEl) findEl(child.descEl, cls, out);
    }
    return out;
}

function validationText(tab) {
    return tab._validationEl ? tab._validationEl.text : null;
}

test("display: 正常配置下渲染语言、范围、删除、重置四个区段", async () => {
    const { tab } = await bootTab();
    tab.display();
    const headings = settings(tab).filter((s) => s.heading).map((s) => s.name);
    assert.deepEqual(headings, ["清理范围", "删除方式", "重置"]);
    // 语言下拉必须是第一个 Setting，和参考插件保持一致。
    assert.equal(settings(tab)[0].name, "Language / 语言");
});

test("display: 配置读坏时仍渲染全部控件，并额外给出修复按钮", async () => {
    const { tab, store } = await bootTab({ saved: { version: 0 } });
    assert.equal(store.broken, true);
    tab.display();
    const headings = settings(tab).filter((s) => s.heading).map((s) => s.name);
    assert.ok(headings.includes("配置文件异常"), "应有异常区段");
    assert.ok(headings.includes("清理范围"), "其余控件也必须在，否则无法修复");
    assert.ok(findByText(tab, "修复配置文件"), "必须有修复按钮");
    // 异常原因原文要显示出来，用户才知道是版本非法还是版本过高。
    const reasonEl = findEl(tab.containerEl, "clear-unused-assets-config-error")[0];
    assert.match(reasonEl.text, /非法/);
});
test("点修复按钮 → 配置写回合法状态，broken 解除", async () => {
    const { tab, store, fake } = await bootTab({ saved: { version: 0, language: "en" } });
    tab.display();
    // 读坏时语言字段仍然生效，所以按钮文案要按当前语言取，不能写死中文。
    await findByText(tab, store.uiText.settingsText.repairButton)._onClick();
    assert.equal(store.broken, false);
    assert.equal(fake._dataStore.current.version, 1);
    assert.match(boot.noticeLog.pop().message, /settings file has been repaired/);
});

test("切换语言 → 立刻落盘并用新语言重绘", async () => {
    const { tab, store, fake } = await bootTab();
    tab.display();
    const dropdown = componentsOf(tab)[0];
    await dropdown._onChange("en");
    assert.equal(fake._dataStore.current.language, "en");
    assert.equal(settings(tab)[0].name, "Language", "重绘后应是英文标签");
    assert.equal(store.value.language, "en");
});

test("两个目录字段是多行输入，扩展名字段是单行 —— 单行装不下多个目录", async () => {
    const { tab } = await bootTab();
    tab.display();
    assert.equal(controlNamed(tab, "清理目录").multiline, true);
    assert.equal(controlNamed(tab, "排除目录").multiline, true);
    assert.equal(controlNamed(tab, "要清理的扩展名").multiline, false);
});

test("下拉框的选项集合与合法取值一一对应 —— 少一个选项会让界面显示错的值", async () => {
    const { tab } = await bootTab();
    tab.display();
    assert.deepEqual(
        controlNamed(tab, "删除到哪里").options.map((o) => o.v),
        DELETE_DESTINATIONS,
    );
    assert.deepEqual(
        settings(tab)[0].components[0].options.map((o) => o.v),
        LANGUAGE_OPTIONS.map((o) => o.value),
    );
});

test("文本字段是防抖落盘：立刻改不写盘，等防抖到点才写", async () => {
    const { tab, fake } = await bootTab({ paths: ["assets/a.png"] });
    tab.display();
    const area = controlNamed(tab, "清理目录");
    let writes = 0;
    const realSave = fake.saveData.bind(fake);
    fake.saveData = async (d) => { writes += 1; return realSave(d); };
    area.__type("a");
    area.__type("as");
    area.__type("assets");
    // 微任务跑完也不该落盘 —— 否则 “防抖” 只是把写推迟了一个 tick。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 0, "防抖期间不应落盘");
    assert.equal(fake._dataStore.current.includeFolders, "");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(writes, 1, "连打三个字只应写一次");
    assert.equal(fake._dataStore.current.includeFolders, "assets");
});

test("校验结果就地显示，不弹 Notice", async () => {
    const { tab } = await bootTab({ paths: ["assets/a.png"] });
    tab.display();
    assert.equal(validationText(tab), "配置有效。");

    const area = controlNamed(tab, "清理目录");
    area.__type("/abs");
    assert.match(validationText(tab), /配置有问题/);
    assert.match(validationText(tab), /不能填绝对路径/);
    assert.equal(boot.noticeLog.length, 0, "逐字校验一律不弹 Notice");
    tab.dispose();
});

test("hide: 切走设置页时冲刷未落盘的文本编辑", async () => {
    const { tab, fake } = await bootTab({ paths: ["assets/a.png"] });
    tab.display();
    const area = controlNamed(tab, "清理目录");
    area.__type("assets");
    tab.hide();
    // hide 里是 fire-and-forget 的 await，给它一轮微任务落盘。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake._dataStore.current.includeFolders, "assets");
});

test("选 permanent → 确认开关被强制打开且禁用", async () => {
    const { tab, store, fake } = await bootTab();
    tab.display();
    await store.setValues({ confirmBeforeDelete: false });
    tab.display();
    await controlNamed(tab, "删除到哪里")._onChange("permanent");
    assert.equal(fake._dataStore.current.confirmBeforeDelete, true);
    const toggle = controlNamed(tab, "删除前需要确认");
    assert.equal(toggle.value, true);
    assert.equal(toggle.disabled, true, "永久删除下不允许关掉确认");
    assert.match(boot.noticeLog.pop().message, /已自动开启删除前确认/);
});

test("重置按钮 → 全部字段回默认，并丢弃排队中的文本编辑", async () => {
    const { tab, store, fake } = await bootTab({ paths: ["assets/a.png"] });
    tab.display();
    await store.setValues({ includeFolders: "assets", extensions: "png" });
    tab.display();
    const area = controlNamed(tab, "清理目录");
    area.__type("assets/typo");
    await findByText(tab, "重置所有设置")._onClick();
    assert.deepEqual(store.value, defaultSettings());
    // 排队中的编辑必须被丢弃，否则防抖到点后又把刚清掉的值写回来。
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(fake._dataStore.current, defaultSettings());
});

test("dispose 之后 display 不再动 DOM", async () => {
    const { tab } = await bootTab();
    tab.display();
    const before = tab.containerEl.children.length;
    tab.dispose();
    tab.display();
    assert.equal(tab.containerEl.children.length, before, "dispose 后应直接返回");
});

test("插件卸载标记置上后设置页视为已废弃", async () => {
    const { tab, fake } = await bootTab();
    fake.__clearUnusedAssetsUnloaded = true;
    assert.equal(tab._isDisposed(), true);
});
