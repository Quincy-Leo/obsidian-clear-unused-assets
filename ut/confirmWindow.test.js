/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const { LANGUAGE_OPTIONS } = require("../src/settings");
const {
    ConfirmDeleteModal,
    MAX_RENDERED_ROWS,
    confirmDeletion,
} = require("../src/confirmWindow");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
// 弹窗的关键契约只有三条，都在这里钉住：
//   1. 普通候选默认勾选，flags 非空的候选默认不勾选
//   2. 结果只在 onClose 里回调一次 —— Esc / 点遮罩 / 关闭按钮都走这条路，
//      所以取消一定能被识别到
//   3. 删除按钮的文案与禁用状态跟着勾选数量走
// ---------------------------------------------------------------------------

const zh = LANGUAGE_OPTIONS.find((o) => o.value === "zh-CN");

/** 从 fake 元素树里深度收集满足条件的节点。 */
function collect(el, predicate, out = []) {
    for (const child of el.children || []) {
        if (predicate(child)) out.push(child);
        if (child.children) collect(child, predicate, out);
    }
    return out;
}

/** ButtonComponent 也会被塞进 children，它没有 classes 字段，所以要防一手。 */
function hasClass(el, cls) {
    return el.classes instanceof Set && el.classes.has(cls);
}

function checkboxes(modal) {
    return collect(modal.contentEl, (el) => el.tag === "input" && el.type === "checkbox");
}

function buttons(modal) {
    return collect(modal.modalEl, (el) => typeof el.setButtonText === "function");
}

function makeModal(candidates, options = {}) {
    const resolved = { value: undefined, calls: 0 };
    const modal = new ConfirmDeleteModal({}, {
        candidates,
        uiText: zh,
        destination: options.destination || ".trash",
        onResolve: (paths) => { resolved.calls += 1; resolved.value = paths; },
    });
    return { modal, resolved };
}

test("普通候选默认勾选，flags 非空的候选默认不勾选", () => {
    const { modal } = makeModal([
        { path: "a.png", flags: [] },
        { path: "b.png", flags: ["duplicate-basename"] },
        { path: "c.png", flags: [] },
    ]);
    modal.open();
    assert.deepEqual([...modal.selected].sort(), ["a.png", "c.png"]);
    const boxes = checkboxes(modal);
    assert.deepEqual(boxes.map((b) => b.checked), [true, false, true]);
});

test("列表展示每个候选的完整路径，可疑项额外显示 flags", () => {
    const { modal } = makeModal([{ path: "assets/img/a.png", flags: ["text-only-match"] }]);
    modal.open();
    const paths = collect(modal.contentEl, (el) => hasClass(el, "clear-unused-assets-path"));
    assert.equal(paths.length, 1);
    assert.equal(paths[0].text, "assets/img/a.png");
    const flags = collect(modal.contentEl, (el) => hasClass(el, "clear-unused-assets-flags"));
    assert.equal(flags[0].text, "text-only-match");
});

test("取消勾选后按钮计数下降，全不选时按钮禁用", () => {
    const { modal } = makeModal([
        { path: "a.png", flags: [] },
        { path: "b.png", flags: [] },
    ]);
    modal.open();
    const deleteButton = buttons(modal)[0];
    assert.equal(deleteButton.text, "删除选中的 2 项");
    assert.equal(deleteButton.disabled, false);

    const boxes = checkboxes(modal);
    boxes[0].checked = false;
    boxes[0].__fire("change");
    assert.equal(deleteButton.text, "删除选中的 1 项");
    boxes[1].checked = false;
    boxes[1].__fire("change");
    assert.equal(deleteButton.text, "删除选中的 0 项");
    assert.equal(deleteButton.disabled, true, "没有勾选任何文件时不允许点删除");
});

test("全选 / 全不选按钮会同步每一行的勾选框", () => {
    const { modal } = makeModal([
        { path: "a.png", flags: [] },
        { path: "b.png", flags: ["unresolved-link"] },
    ]);
    modal.open();
    const bulk = collect(modal.contentEl, (el) => typeof el.setButtonText === "function");
    const selectAll = bulk.find((b) => b.text === "全选");
    const selectNone = bulk.find((b) => b.text === "全不选");

    selectAll._onClick();
    assert.deepEqual(checkboxes(modal).map((b) => b.checked), [true, true]);
    assert.equal(modal.selected.size, 2);

    selectNone._onClick();
    assert.deepEqual(checkboxes(modal).map((b) => b.checked), [false, false]);
    assert.equal(modal.selected.size, 0);
});

test("点删除 → 回调收到勾选的路径，且只回调一次", () => {
    const { modal, resolved } = makeModal([
        { path: "a.png", flags: [] },
        { path: "b.png", flags: [] },
    ]);
    modal.open();
    const boxes = checkboxes(modal);
    boxes[1].checked = false;
    boxes[1].__fire("change");
    buttons(modal)[0]._onClick();
    assert.equal(resolved.calls, 1);
    assert.deepEqual(resolved.value, ["a.png"]);
    // 直接再调一次 onClose —— 真实 Obsidian 的某些清理路径会重入，
    // 这里绕过 close() 的 __open 短路，专测 _resolved 这道闸。
    modal.onClose();
    assert.equal(resolved.calls, 1);
    modal.close();
    assert.equal(resolved.calls, 1);
});

test("点取消 → 回调收到 null", () => {
    const { modal, resolved } = makeModal([{ path: "a.png", flags: [] }]);
    modal.open();
    const cancelButton = buttons(modal).find((b) => b.text === "取消");
    cancelButton._onClick();
    assert.equal(resolved.value, null);
});

test("Esc / 点遮罩（直接 close）也算取消 —— onClose 是唯一出口", () => {
    const { modal, resolved } = makeModal([{ path: "a.png", flags: [] }]);
    modal.open();
    modal.close();
    assert.equal(resolved.calls, 1);
    assert.equal(resolved.value, null, "没有显式确认就一律按取消");
});

test("删除按钮在 0 勾选时点了也不确认", () => {
    const { modal, resolved } = makeModal([{ path: "a.png", flags: ["text-only-match"] }]);
    modal.open();
    assert.equal(modal.selected.size, 0);
    buttons(modal)[0]._onClick();
    assert.equal(modal.confirmed, false);
    assert.equal(resolved.calls, 0, "按钮禁用时不应关闭弹窗");
});

test("弹窗里写明删除去向，永久删除额外标红", () => {
    for (const [destination, expected] of [
        [".trash", "去向：Obsidian 回收站（.trash）"],
        ["system-trash", "去向：系统回收站"],
        ["permanent", "去向：永久删除，不可恢复"],
        ["obsidian-setting", "去向：跟随 Obsidian 的 “已删除的文件” 设置"],
    ]) {
        const { modal } = makeModal([{ path: "a.png", flags: [] }], { destination });
        modal.open();
        const el = collect(
            modal.contentEl,
            (node) => hasClass(node, "clear-unused-assets-destination"),
        )[0];
        assert.equal(el.text, expected);
        if (destination === "permanent") {
            assert.equal(el.style.color, "var(--text-error)");
        }
    }
});

test("有可疑项时提示其数量", () => {
    const { modal } = makeModal([
        { path: "a.png", flags: [] },
        { path: "b.png", flags: ["duplicate-basename"] },
        { path: "c.png", flags: ["text-only-match"] },
    ]);
    modal.open();
    const hint = collect(
        modal.contentEl,
        (el) => hasClass(el, "clear-unused-assets-flagged-hint"),
    )[0];
    assert.match(hint.text, /其中 2 个存在疑点/);
});

test("每个勾选框都带 aria-label，屏幕阅读器不会读出一排无名复选框", () => {
    const { modal } = makeModal([{ path: "assets/a.png", flags: [] }]);
    modal.open();
    assert.equal(checkboxes(modal)[0].attrs["aria-label"], "assets/a.png");
});

test("候选数超过渲染上限时，未显示的那些默认不勾选 —— 看不见就不能删", () => {
    const many = [];
    for (let i = 0; i < MAX_RENDERED_ROWS + 5; i++) {
        many.push({ path: `assets/a${i}.png`, flags: [] });
    }
    const { modal, resolved } = makeModal(many);
    modal.open();
    assert.equal(checkboxes(modal).length, MAX_RENDERED_ROWS);
    assert.equal(modal.selected.size, MAX_RENDERED_ROWS);
    // 截断提示要说清这些文件不会被删（断言要在 close 之前，onClose 会清空 DOM）。
    const note = collect(
        modal.contentEl,
        (el) => hasClass(el, "clear-unused-assets-truncated"),
    )[0];
    assert.match(note.text, /另有 5 个文件未显示/);
    assert.match(note.text, /不会被删除/);
    // 全选也只作用于看得见的那些行。
    const selectAll = collect(modal.contentEl, (el) => el.text === "全选")[0];
    selectAll._onClick();
    assert.equal(modal.selected.size, MAX_RENDERED_ROWS);
    buttons(modal)[0]._onClick();
    assert.equal(resolved.value.length, MAX_RENDERED_ROWS);
    assert.ok(!resolved.value.includes(`assets/a${MAX_RENDERED_ROWS}.png`));
});

test("confirmDeletion: onModal 先收到弹窗，resolve 后收到 null", async () => {
    const seen = [];
    const pending = confirmDeletion({}, {
        candidates: [{ path: "a.png", flags: [] }],
        uiText: zh,
        destination: ".trash",
        onModal: (modal) => seen.push(modal),
    });
    assert.equal(seen.length, 1);
    assert.ok(seen[0] instanceof ConfirmDeleteModal);
    // 模拟卸载时外部把弹窗关掉。
    seen[0].close();
    assert.equal(await pending, null);
    assert.equal(seen[1], null, "resolve 后必须撤掉引用，避免卸载时重复关闭");
});
