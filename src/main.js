/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { Notice, Plugin, setTooltip } = require("obsidian");
const {
    LANGUAGE_OPTIONS,
    ClearAssetsSettings,
    ClearAssetsSettingTab,
    defaultSettings,
    formatTemplate,
    localizedError,
} = require("./settings");
const { resolveScope } = require("./scope");
const {
    ClearAssetsJob,
    REASON_PARSE_FAILED,
    REASON_SUSPICIOUS,
    REASON_VAULT_CHANGED,
} = require("./clear");
const { confirmDeletion } = require("./confirmWindow");

const PLUGIN_VERSION = "0.1.0";
const CLEAR_COMMAND_ID = "clear-unused-assets";
const RIBBON_ICON_ID = "image-file";
const NOTICE_DURATION_MS = 4000;

class ClearUnusedAssetsPlugin extends Plugin {
    constructor(...args) {
        super(...args);
        this.settings = null;
        this.settingsStore = null;
        this.settingsError = null;
        this.clearJob = null;
        this.clearCommand = null;
        this.ribbonIconEl = null;
        this.confirmModal = null;
        this.clearing = false;
        this.__clearUnusedAssetsUnloaded = false;
        this._lifecycleGeneration = 0;
        this._settingTabs = new Set();
        this.clearAssets = () => {
            void this.clearUnusedAssets();
        };
    }

    async onload() {
        this.__clearUnusedAssetsUnloaded = false;
        this._lifecycleGeneration += 1;
        this.settingsStore = new ClearAssetsSettings(this, () => {
            this.settings = this.settingsStore.value;
            this.settingsError = this.settingsStore.loadError;
            this.refreshLocalizedEntryLabels();
        });
        await this.loadSettings();
        this.clearJob = new ClearAssetsJob(this);

        this.clearCommand = this.addCommand({
            id: CLEAR_COMMAND_ID,
            name: this.uiText.commandName,
            callback: this.clearAssets,
        });

        this.ribbonIconEl = this.addRibbonIcon(
            RIBBON_ICON_ID,
            this.uiText.ribbonTitle,
            this.clearAssets,
        );
        if (this.ribbonIconEl && typeof setTooltip === "function") {
            setTooltip(this.ribbonIconEl, this.uiText.ribbonTitle);
        }

        const settingTab = new ClearAssetsSettingTab(this.app, this.settingsStore);
        this._settingTabs.add(settingTab);
        this.addSettingTab(settingTab);

        console.log(`clear-unused-assets ${PLUGIN_VERSION} loaded`);
    }

    onunload() {
        if (this.__clearUnusedAssetsUnloaded) return;
        // Mark the lifecycle inactive before touching async resources. Pending
        // jobs use this flag and the generation to suppress later side effects.
        this.__clearUnusedAssetsUnloaded = true;
        this._lifecycleGeneration += 1;
        this.clearing = false;

        for (const tab of this._settingTabs) {
            if (tab && typeof tab.dispose === "function") tab.dispose();
        }
        if (this.__clearUnusedAssetsSettingTabs instanceof Set) {
            for (const tab of this.__clearUnusedAssetsSettingTabs) {
                if (tab && typeof tab.dispose === "function") tab.dispose();
            }
        }

        // A confirm modal is NOT closed by Obsidian when a plugin unloads, so an
        // abandoned one could still resolve and delete with a torn-down plugin.
        // Closing it here routes through its onClose, which resolves as cancel.
        if (this.confirmModal && typeof this.confirmModal.close === "function") {
            try {
                this.confirmModal.close();
            } catch (error) {
                console.error("clear-unused-assets: failed to close the confirm modal", error);
            }
        }
        this.confirmModal = null;

        // Synchronous cancellation marks pending work first, so guarded
        // continuations skip their remaining persistent and user-visible
        // effects while the rest of the run unwinds.
        const job = this.clearJob;
        if (job && typeof job.cancel === "function") job.cancel();
        this.clearJob = null;
        // Drop the command handle too: Obsidian has already unregistered it, so
        // a late settings save must not find one to re-register.
        this.clearCommand = null;
        this.ribbonIconEl = null;
    }

    get uiText() {
        return this.settingsStore
            ? this.settingsStore.uiText
            : LANGUAGE_OPTIONS[0];
    }

    /**
     * Read settings, tolerating a broken `data.json`. Unlike the sibling plugin
     * this does not rethrow: the plugin has to finish loading so the user can
     * reach the settings page and repair the file. Both entry points refuse to
     * run while {@link settingsError} is set.
     */
    async loadSettings() {
        try {
            this.settingsError = null;
            this.settings = await this.settingsStore.load();
        } catch (error) {
            this.settingsError = error;
            // load() leaves defaults in `value` on failure so the settings page
            // still renders every control — that is the repair path.
            this.settings = this.settingsStore.value || defaultSettings();
            console.error("clear-unused-assets: failed to load settings", error);
            new Notice(this._prefixed(error), NOTICE_DURATION_MS);
        }
        return this.settings;
    }

    /**
     * Localised errors already begin with `clear-unused-assets:` /
     * `clear-unused-assets：`; re-prefixing one would read
     * "clear-unused-assets: clear-unused-assets: …". Anything else — a stray
     * runtime exception with no locale context — gets the prefix so the user
     * can tell which plugin raised it.
     */
    _prefixed(error) {
        const raw = error instanceof Error ? error.message : String(error);
        return /^clear-unused-assets[:：]/.test(raw) ? raw : `clear-unused-assets: ${raw}`;
    }

    refreshLocalizedEntryLabels() {
        // A save that resolves after unload must not re-register the command:
        // Obsidian has already flushed its own cleanup, so the new registration
        // would outlive the plugin as a dead palette entry.
        if (this.__clearUnusedAssetsUnloaded) return;
        if (this.clearCommand) {
            if (typeof this.removeCommand === "function") {
                this.removeCommand(CLEAR_COMMAND_ID);
                this.clearCommand = this.addCommand({
                    id: CLEAR_COMMAND_ID,
                    name: this.uiText.commandName,
                    callback: this.clearAssets,
                });
            } else {
                this.clearCommand.name = this.uiText.commandName;
            }
        }
        if (this.ribbonIconEl) {
            if (typeof setTooltip === "function") {
                setTooltip(this.ribbonIconEl, this.uiText.ribbonTitle);
            }
            this.ribbonIconEl.setAttribute("aria-label", this.uiText.ribbonTitle);
        }
    }

    /**
     * The one entry point behind both the command and the ribbon icon.
     *
     * `this.clearing` spans scan → confirm → delete as a single operation:
     * re-entering while a modal is open would produce two modals over the same
     * candidate list and two delete passes, the second failing on files the
     * first already removed.
     */
    async clearUnusedAssets() {
        if (this.__clearUnusedAssetsUnloaded || this.clearing) return;
        // Check the store as well as the mirrored flag: a save that fails its
        // version check reloads and can mark the store broken without going
        // through onChanged, which is what maintains the mirror.
        if (this.settingsError || (this.settingsStore && this.settingsStore.broken)) {
            new Notice(localizedError(this.uiText, "settingsUnusable"), NOTICE_DURATION_MS);
            return;
        }

        const job = this.clearJob;
        if (!job) return;

        this.clearing = true;
        const lifecycleGeneration = this._lifecycleGeneration;
        try {
            // Validation and the cache probe run inside the try so a throw from
            // either reaches the user as a Notice. The entry-point wrapper
            // discards the returned promise, so nothing else would report it.
            const scope = resolveScope(this.settings, this.app.vault);
            if (!scope.ok) {
                // Report every problem at once rather than one Notice per run:
                // the folder lists are multiline, so several lines can be wrong.
                const message = scope.errors
                    .map((problem) => localizedError(this.uiText, problem.key, problem.params))
                    .join("\n");
                new Notice(message, NOTICE_DURATION_MS);
                return;
            }
            if (typeof job.isCacheReady === "function" && !job.isCacheReady()) {
                new Notice(localizedError(this.uiText, "cacheNotReady"), NOTICE_DURATION_MS);
                return;
            }

            new Notice(this.uiText.notice.start, NOTICE_DURATION_MS);
            const result = await job.run(scope);
            if (this._isStale(lifecycleGeneration) || result.cancelled) return;
            if (result.aborted) {
                new Notice(this._abortMessage(result), NOTICE_DURATION_MS);
                return;
            }
            if (result.candidates.length === 0) {
                new Notice(this.uiText.notice.nothing, NOTICE_DURATION_MS);
                return;
            }

            const selected = await this._selectForDeletion(result.candidates);
            if (this._isStale(lifecycleGeneration)) return;
            if (selected === null || selected.length === 0) {
                new Notice(this.uiText.notice.cancelled, NOTICE_DURATION_MS);
                return;
            }

            const deletion = await job.deleteSelected(selected, {
                destination: this.settings.deleteDestination,
            });
            // Always log what was deleted, even for a run that went stale
            // mid-delete: those files are gone, and the console list is the only
            // record the user has.
            const silent = this._isStale(lifecycleGeneration) || deletion.cancelled;
            this._reportDeletion(deletion, silent);
        } catch (error) {
            if (this._isStale(lifecycleGeneration)) return;
            console.error("clear-unused-assets: clear failed", error);
            new Notice(this._prefixed(error), NOTICE_DURATION_MS);
        } finally {
            this.clearing = false;
        }
    }

    /** True once this run's side effects must be suppressed. */
    _isStale(lifecycleGeneration) {
        return this.__clearUnusedAssetsUnloaded
            || lifecycleGeneration !== this._lifecycleGeneration;
    }

    /**
     * Turn a fail-closed scan into the localized reason it refused. Every abort
     * names the file responsible so the user can inspect it rather than being
     * told only that something went wrong.
     */
    _abortMessage(result) {
        const reason = result.abortReason;
        if (reason && reason.kind === REASON_VAULT_CHANGED) {
            return localizedError(this.uiText, "scanVaultChanged");
        }
        if (reason && reason.kind === REASON_PARSE_FAILED) {
            return localizedError(this.uiText, "scanParseFailed", { path: reason.path });
        }
        if (reason && reason.kind === REASON_SUSPICIOUS) {
            // The counts come from the reason, not from `candidates`: an aborted
            // run is not required to carry the candidate list, and reading a
            // discarded list here would report "0 of N" for the very tripwire
            // that fired because the number was too high.
            return localizedError(this.uiText, "scanSuspicious", {
                candidates: reason.candidates,
                total: reason.total,
            });
        }
        // Everything else — including a missing reason and any kind a future
        // clear.js adds — is reported as an unreadable source file, which is the
        // conservative reading: something the scan needed could not be counted.
        return localizedError(this.uiText, "scanReadFailed", {
            path: (reason && reason.path) || "?",
        });
    }

    /**
     * Ask the user which candidates may go, or return all of them when
     * confirmation is off. Returns `null` when the user cancelled.
     *
     * @param {Array<{ path: string, flags: string[] }>} candidates
     * @returns {Promise<string[] | null>}
     */
    async _selectForDeletion(candidates) {
        if (!this.settings.confirmBeforeDelete) {
            return candidates.map((candidate) => candidate.path);
        }
        return confirmDeletion(this.app, {
            candidates,
            uiText: this.uiText,
            destination: this.settings.deleteDestination,
            onModal: (modal) => { this.confirmModal = modal; },
        });
    }

    /**
     * One Notice with the counts; the full path lists go to the console, which
     * keeps the Notice readable while still leaving an auditable record of a
     * destructive operation.
     *
     * @param {{ deleted: string[], kept: object[], failed: object[], destinationUsed: string }} deletion
     * @param {boolean} [silent] Suppress the Notice (run went stale) but still
     *     log: files already deleted must be recorded regardless.
     */
    _reportDeletion(deletion, silent) {
        console.log(
            "clear-unused-assets: deleted",
            deletion.deleted,
            "destination:",
            deletion.destinationUsed,
        );
        if (deletion.kept.length > 0) {
            console.log("clear-unused-assets: kept", deletion.kept);
        }
        if (deletion.failed.length > 0) {
            console.error("clear-unused-assets: failed to delete", deletion.failed);
        }
        if (silent) return;
        const message = formatTemplate(this.uiText.notice.deleted, {
            deleted: deletion.deleted.length,
            kept: deletion.kept.length,
            failed: deletion.failed.length,
        });
        // Deleting is irreversible at some destinations, so a destination the
        // job could not honour has to be disclosed rather than left in the log.
        const fellBack = deletion.destinationUsed
            && deletion.destinationUsed !== this.settings.deleteDestination;
        const suffix = fellBack
            ? `\n${formatTemplate(this.uiText.notice.destinationFallback, {
                requested: this.settings.deleteDestination,
                used: deletion.destinationUsed,
            })}`
            : "";
        new Notice(`${message}${suffix}`, NOTICE_DURATION_MS);
    }
}

// Default export loaded by the Obsidian plugin runtime.
module.exports = ClearUnusedAssetsPlugin;

// Named export used by the Node unit tests.
module.exports.ClearUnusedAssetsPlugin = ClearUnusedAssetsPlugin;
