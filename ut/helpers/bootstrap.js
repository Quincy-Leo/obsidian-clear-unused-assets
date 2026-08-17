/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// 单测运行前的环境准备
// ---------------------------------------------------------------------------
//
// 目的：让 src/ 下的模块能在纯 Node 环境（没有 Obsidian 主进程、没有浏览器
// DOM）里被 require 并调用。策略是把不存在的运行时依赖用最小可用的 fake
// 实现替换掉：
//
//   1. `obsidian` 是宿主提供且本项目未安装的运行时模块，这里通过改写
//      Module._resolveFilename 让 `require("obsidian")` 命中测试桩。
//   2. Setting / Modal / ButtonComponent 等 UI 控件走桩，暴露可检查的状态，
//      让测试能断言渲染结果并模拟点击、勾选。
//   3. Notice 收集到 noticeLog，测试直接断言弹窗文本。
//
// 本插件不读图、不用 IndexedDB，所以没有 Image / indexedDB / Blob URL 相关桩。
//
// 每个测试文件在最前面 `require("./helpers/bootstrap")` 即可。
// 这个文件是幂等的：重复 require 只装一次桩。

const Module = require("node:module");
const path = require("node:path");

if (globalThis.__clearUnusedAssetsBootstrapped) {
    module.exports = globalThis.__clearUnusedAssetsBootstrap;
    return;
}
globalThis.__clearUnusedAssetsBootstrapped = true;

// --- Notice 收集器 --------------------------------------------------------
// 让测试可以断言弹窗内容而不用 mock Notice 类本身。
const noticeLog = [];

// --- obsidian 桩 ----------------------------------------------------------
// 仅实现被 src/ 引用到的成员；行为足够让被测代码走通，但不模拟完整的
// Obsidian API。
class Notice {
    constructor(message, duration) {
        this.message = message;
        this.duration = duration;
        noticeLog.push({ message, duration });
    }
}

class Plugin {
    constructor(app, manifest) {
        this.app = app || {};
        this.manifest = manifest || {};
    }
    // src/main.js 需要的方法 —— 返回值不重要，测试里只关心副作用/参数。
    addCommand(spec) { return spec; }
    addRibbonIcon(_icon, _title, _cb) { return { setAttribute() {} }; }
    addSettingTab(_tab) {}
    removeCommand(_id) {}
    async loadData() { return null; }
    async saveData(_data) {}
}

class PluginSettingTab {
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = createFakeEl();
    }
}

// TFile / TFolder 只用于 instanceof 判定：scope.js 的 isFolderEntry 优先走
// instanceof，取不到才退化成 “有 children 数组就是目录”。
class TFile {}
class TFolder {
    constructor() { this.children = []; }
}

class Setting {
    constructor(containerEl) {
        this.containerEl = containerEl;
        this.descEl = createFakeEl();
        this.controlEl = createFakeEl();
        this.components = [];
        this.name = "";
        this.desc = "";
        this.heading = false;
        containerEl.children.push(this);
    }
    setName(n) { this.name = n; return this; }
    setDesc(d) { this.desc = d; return this; }
    setHeading() { this.heading = true; return this; }
    setClass(_c) { return this; }
    setDisabled(_b) { return this; }
    addDropdown(cb) { return this._add(new FakeDropdown(), cb); }
    addButton(cb) { return this._add(new FakeButton(), cb); }
    addToggle(cb) { return this._add(new FakeToggle(), cb); }
    addText(cb) { return this._add(new FakeText(), cb); }
    addTextArea(cb) { return this._add(new FakeTextArea(), cb); }
    _add(component, cb) {
        this.components.push(component);
        cb(component);
        return this;
    }
}

class FakeDropdown {
    constructor() { this.options = []; this.value = null; this.disabled = false; }
    addOption(v, l) { this.options.push({ v, l }); return this; }
    addOptions(map) {
        for (const [v, l] of Object.entries(map)) this.addOption(v, l);
        return this;
    }
    getValue() { return this.value; }
    setValue(v) {
        // 真实 <select> 收到没有对应 <option> 的值时会退回显示第一项 —— 界面
        // 于是和存储的值不一致。这里如实模拟，别让这类 bug 在测试里蒙混过关。
        this.requestedValue = v;
        this.value = this.options.some((o) => o.v === v)
            ? v
            : (this.options.length > 0 ? this.options[0].v : null);
        return this;
    }
    setDisabled(b) { this.disabled = b; return this; }
    onChange(cb) { this._onChange = cb; return this; }
}

class FakeButton {
    constructor() { this.disabled = false; this.cta = false; this.warning = false; }
    setButtonText(text) { this.text = text; return this; }
    setIcon(icon) { this.icon = icon; return this; }
    setCta() { this.cta = true; return this; }
    removeCta() { this.cta = false; return this; }
    setWarning() { this.warning = true; return this; }
    setTooltip(_t) { return this; }
    setDisabled(b) { this.disabled = b; return this; }
    onClick(cb) { this._onClick = cb; return this; }
}

class FakeToggle {
    constructor() { this.value = false; this.disabled = false; }
    getValue() { return this.value; }
    setValue(v) { this.value = v; return this; }
    setTooltip(_t) { return this; }
    setDisabled(b) { this.disabled = b; return this; }
    onChange(cb) { this._onChange = cb; return this; }
}

class FakeText {
    constructor() {
        this.value = "";
        this.placeholder = "";
        this.disabled = false;
        this.multiline = false;
        this.inputEl = createFakeEl();
        this.inputEl.tag = "input";
    }
    getValue() { return this.value; }
    setValue(v) { this.value = v; return this; }
    setPlaceholder(p) { this.placeholder = p; return this; }
    setDisabled(b) { this.disabled = b; return this; }
    onChange(cb) { this._onChange = cb; return this; }
    /** 测试里用它模拟用户输入。 */
    __type(v) { this.value = v; this._onChange && this._onChange(v); }
}

// 单行 input 装不下换行，所以 “多行目录列表” 这个需求只有靠区分这两个控件
// 才测得出来 —— 标记必须留着。
class FakeTextArea extends FakeText {
    constructor() {
        super();
        this.multiline = true;
        this.inputEl.tag = "textarea";
    }
}

// ButtonComponent 在 confirmWindow.js 里脱离 Setting 直接 new，所以要能接受
// 一个容器元素并把自己挂进去。
class ButtonComponent extends FakeButton {
    constructor(containerEl) {
        super();
        this.containerEl = containerEl;
        this.buttonEl = createFakeEl();
        if (containerEl && Array.isArray(containerEl.children)) {
            containerEl.children.push(this);
        }
    }
}

class Modal {
    constructor(app) {
        this.app = app;
        this.containerEl = createFakeEl();
        this.modalEl = createFakeEl();
        this.titleEl = createFakeEl();
        this.contentEl = createFakeEl();
        this.__open = false;
    }
    open() {
        this.__open = true;
        if (typeof this.onOpen === "function") this.onOpen();
    }
    close() {
        // 真实 Obsidian 里 Esc / 点遮罩 / 关闭按钮都会走 close()，而某些清理
        // 路径会重入。这里不做去重 —— 去重必须由被测代码自己的 _resolved 闸
        // 完成，否则那条断言测的是桩而不是代码。
        this.__open = false;
        if (typeof this.onClose === "function") this.onClose();
    }
    setTitle(title) { this.titleEl.setText(title); return this; }
}

function setTooltip(_el, _text) { /* no-op */ }

// Very small subset of Obsidian's DOM helper contract used in src/.
function createFakeEl() {
    return {
        children: [],
        classes: new Set(),
        listeners: {},
        text: "",
        style: {},
        attrs: {},
        checked: false,
        disabled: false,
        empty() { this.children = []; },
        createDiv(opts) {
            const el = createFakeEl();
            el.tag = "div";
            applyElOptions(el, opts);
            this.children.push(el);
            return el;
        },
        createEl(tag, opts) {
            const el = createFakeEl();
            el.tag = tag;
            applyElOptions(el, opts);
            this.children.push(el);
            return el;
        },
        setText(t) { this.text = String(t); },
        addClass(...cls) { for (const c of cls) this.classes.add(c); },
        removeClass(c) { this.classes.delete(c); },
        setAttribute(k, v) { this.attrs[k] = v; },
        querySelector() { return null; },
        addEventListener(name, cb) { this.listeners[name] = cb; },
        /** 测试里用它模拟用户点击 / 勾选。 */
        __fire(name, evt) { this.listeners[name] && this.listeners[name](evt || {}); },
    };
}

function applyElOptions(el, opts) {
    // Obsidian 允许 opts 直接写成字符串，等价于 { cls }。
    if (typeof opts === "string") { el.classes.add(opts); return; }
    if (!opts) return;
    if (opts.text) el.text = String(opts.text);
    if (opts.cls) {
        for (const c of Array.isArray(opts.cls) ? opts.cls : [opts.cls]) el.classes.add(c);
    }
    if (opts.type) el.type = opts.type;
    if (opts.attr) Object.assign(el.attrs, opts.attr);
}

function normalizePath(p) {
    // Mirror Obsidian's behaviour just enough: collapse `//`, strip trailing `/`.
    return String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

const obsidianStub = {
    ButtonComponent,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
    normalizePath,
    setTooltip,
};

// Patch Module resolver: `require("obsidian")` → our stub. Any other name is
// resolved normally.
const originalResolve = Module._resolveFilename;
const OBSIDIAN_STUB_ID = path.join(__dirname, "__obsidian_stub__.js");
require.cache[OBSIDIAN_STUB_ID] = {
    id: OBSIDIAN_STUB_ID,
    filename: OBSIDIAN_STUB_ID,
    loaded: true,
    exports: obsidianStub,
    children: [],
    paths: [],
};
Module._resolveFilename = function patched(request, parent, ...rest) {
    if (request === "obsidian") return OBSIDIAN_STUB_ID;
    return originalResolve.call(this, request, parent, ...rest);
};

// --- 导出的钩子 -----------------------------------------------------------
const api = {
    obsidian: obsidianStub,
    noticeLog,
    resetNotices() { noticeLog.length = 0; },
    createFakeEl,
};
globalThis.__clearUnusedAssetsBootstrap = api;
module.exports = api;
