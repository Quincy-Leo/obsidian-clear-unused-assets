/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// confirmWindow.js — the "which of these may I delete?" checkbox list
// ---------------------------------------------------------------------------
//
// One checkbox per candidate, ticked by default; unticking a row keeps that
// file. Flagged candidates (see the FLAG_* vocabulary in clear.js) start
// unticked instead, because they are the ones this plugin is least sure about.
//
// The modal reports through a single callback invoked exactly once from
// `onClose`, with the selected paths on confirm and `null` on cancel. That is
// the only exit path guaranteed to run: Escape, clicking the backdrop, and the
// close button all route through `close()` → `onClose()`, whereas a
// button-only callback would silently drop those three cases.

const { ButtonComponent, Modal } = require("obsidian");

const { formatTemplate } = require("./settings");

// Rendering a checkbox row per candidate is cheap, but a vault can produce
// thousands. Beyond this cap the remaining candidates are listed as a count and
// are NOT selected: a file with no checkbox is a file the user could not choose
// to keep, so the safe default is to leave it alone.
const MAX_RENDERED_ROWS = 2000;

class ConfirmDeleteModal extends Modal {
    /**
     * @param {import("obsidian").App} app
     * @param {{
     *   candidates: Array<{ path: string, flags: string[] }>,
     *   uiText: { settingsText: Record<string, string> },
     *   destination: string,
     *   onResolve: (paths: string[] | null) => void,
     * }} options
     */
    constructor(app, options) {
        super(app);
        this.candidates = options.candidates || [];
        this.uiText = options.uiText;
        this.destination = options.destination;
        this.onResolve = options.onResolve || (() => {});
        // Only rows the user can actually see and untick start selected.
        // Flagged candidates start unticked too — they are reported precisely
        // because the scan could not vouch for them.
        this.shown = this.candidates.slice(0, MAX_RENDERED_ROWS);
        this.selected = new Set(
            this.shown
                .filter((candidate) => !candidate.flags || candidate.flags.length === 0)
                .map((candidate) => candidate.path),
        );
        this.confirmed = false;
        this._resolved = false;
        this._rows = [];
        this._deleteButton = null;
    }

    onOpen() {
        const text = this.uiText.settingsText;
        // Obsidian's own bulk-delete modal uses this class to make
        // .modal-content scrollable with the button row pinned below it.
        this.modalEl.addClass("mod-scrollable-content");
        this.titleEl.setText(text.modalTitle);

        const { contentEl } = this;
        contentEl.createEl("p", {
            text: formatTemplate(text.modalSummary, { total: this.candidates.length }),
        });

        const flaggedCount = this.candidates.filter(
            (candidate) => candidate.flags && candidate.flags.length > 0,
        ).length;
        if (flaggedCount > 0) {
            contentEl.createEl("p", {
                text: formatTemplate(text.modalFlaggedHint, { count: flaggedCount }),
                cls: "clear-unused-assets-flagged-hint",
            });
        }

        // Name the destination in the modal: "delete" means something very
        // different at "permanent" than at ".trash", and the settings page is
        // not on screen at the moment of the decision.
        const destinationEl = contentEl.createEl("p", {
            text: this._destinationText(text),
            cls: "clear-unused-assets-destination",
        });
        if (this.destination === "permanent") {
            destinationEl.style.color = "var(--text-error)";
        }

        this._renderBulkButtons(text, contentEl);
        this._renderList(contentEl);
        this._renderFooter(text);
        this._syncDeleteButton(text);
    }

    onClose() {
        this.contentEl.empty();
        // Single exit point: anything other than an explicit confirm — Escape,
        // backdrop click, the X button — counts as cancel.
        if (this._resolved) return;
        this._resolved = true;
        this.onResolve(this.confirmed ? [...this.selected] : null);
    }

    _destinationText(text) {
        if (this.destination === "permanent") return text.modalDestinationPermanent;
        if (this.destination === "system-trash") return text.modalDestinationSystemTrash;
        if (this.destination === ".trash") return text.modalDestinationTrash;
        return text.modalDestinationObsidianSetting;
    }

    _renderBulkButtons(text, contentEl) {
        const barEl = contentEl.createDiv("clear-unused-assets-bulk");
        barEl.style.display = "flex";
        barEl.style.gap = "0.5em";
        barEl.style.marginBottom = "0.75em";
        new ButtonComponent(barEl).setButtonText(text.modalSelectAll).onClick(() => {
            for (const candidate of this.shown) this.selected.add(candidate.path);
            this._syncRows();
            this._syncDeleteButton(text);
        });
        new ButtonComponent(barEl).setButtonText(text.modalSelectNone).onClick(() => {
            this.selected.clear();
            this._syncRows();
            this._syncDeleteButton(text);
        });
    }

    _renderList(contentEl) {
        const text = this.uiText.settingsText;
        const listEl = contentEl.createDiv("clear-unused-assets-list");
        // The theme may not know our classes, so keep the list scrollable on its
        // own rather than relying only on `mod-scrollable-content`.
        listEl.style.maxHeight = "50vh";
        listEl.style.overflow = "auto";
        listEl.style.border = "1px solid var(--background-modifier-border)";
        listEl.style.borderRadius = "6px";
        listEl.style.padding = "0.4em 0.6em";

        const shown = this.shown;
        for (const candidate of shown) {
            const rowEl = listEl.createDiv("clear-unused-assets-row");
            rowEl.style.display = "flex";
            rowEl.style.alignItems = "center";
            rowEl.style.gap = "0.5em";
            const checkboxEl = rowEl.createEl("input", { type: "checkbox" });
            checkboxEl.checked = this.selected.has(candidate.path);
            // The path lives in a sibling div rather than a wrapping label, so
            // the checkbox needs the name spelled out for screen readers.
            checkboxEl.setAttribute("aria-label", candidate.path);
            checkboxEl.addEventListener("change", () => {
                if (checkboxEl.checked) this.selected.add(candidate.path);
                else this.selected.delete(candidate.path);
                this._syncDeleteButton(text);
            });
            const pathEl = rowEl.createDiv({
                text: candidate.path,
                cls: "clear-unused-assets-path",
            });
            pathEl.style.overflowWrap = "anywhere";
            if (candidate.flags && candidate.flags.length > 0) {
                // The flag list is diagnostic, not prose: it names which check
                // was inconclusive so the user can judge the row themselves.
                const flagEl = rowEl.createDiv({
                    text: candidate.flags.join(", "),
                    cls: "clear-unused-assets-flags",
                });
                flagEl.style.marginLeft = "auto";
                flagEl.style.color = "var(--text-muted)";
                flagEl.style.fontSize = "var(--font-ui-smaller)";
            }
            this._rows.push({ path: candidate.path, checkboxEl });
        }
        if (this.candidates.length > shown.length) {
            listEl.createDiv({
                text: formatTemplate(text.modalTruncated, {
                    count: this.candidates.length - shown.length,
                }),
                cls: "clear-unused-assets-truncated",
            });
        }
    }

    _renderFooter(text) {
        const footerEl = this.modalEl.createDiv("modal-button-container");
        this._deleteButton = new ButtonComponent(footerEl)
            .setWarning()
            .onClick(() => {
                if (this.selected.size === 0) return;
                this.confirmed = true;
                this.close();
            });
        new ButtonComponent(footerEl)
            .setButtonText(text.modalCancelButton)
            .onClick(() => this.close());
    }

    _syncRows() {
        for (const row of this._rows) {
            row.checkboxEl.checked = this.selected.has(row.path);
        }
    }

    _syncDeleteButton(text) {
        if (!this._deleteButton) return;
        this._deleteButton
            .setButtonText(formatTemplate(text.modalDeleteButton, { count: this.selected.size }))
            .setDisabled(this.selected.size === 0);
    }
}

/**
 * Open the modal and resolve to the confirmed paths, or to `null` on cancel.
 *
 * @param {import("obsidian").App} app
 * @param {{
 *   candidates: Array<{ path: string, flags: string[] }>,
 *   uiText: { settingsText: Record<string, string> },
 *   destination: string,
 *   onModal?: (modal: ConfirmDeleteModal | null) => void,
 * }} options `onModal` receives the modal on open and `null` once it has
 *     resolved, so the caller can close an abandoned one during unload.
 * @returns {Promise<string[] | null>}
 */
function confirmDeletion(app, options) {
    const onModal = (options && options.onModal) || (() => {});
    return new Promise((resolve) => {
        const modal = new ConfirmDeleteModal(app, {
            ...options,
            onResolve: (paths) => {
                onModal(null);
                resolve(paths);
            },
        });
        onModal(modal);
        modal.open();
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
//
// 其他模块会调用的接口：
//   - confirmDeletion       打开确认弹窗并等待结果（main.js 在删除前调用）
//   - ConfirmDeleteModal    弹窗本体（导出以便单元测试直接构造）
//   - MAX_RENDERED_ROWS     最多渲染多少行；超出的候选只报数量且默认不勾选
//
// 用户操作触发的接口（导出以便单元测试直接构造相应类后调用）：
//   - ConfirmDeleteModal.prototype.onOpen()
//       由 Obsidian 在 open() 时触发，构建勾选列表与按钮。
//   - ConfirmDeleteModal.prototype.onClose()
//       由 Obsidian 在 close() 时触发（含 Esc / 点击遮罩 / 关闭按钮），
//       是唯一保证执行的出口，因此结果在这里一次性回调。
module.exports = {
    confirmDeletion,
    ConfirmDeleteModal,
    MAX_RENDERED_ROWS,
};
