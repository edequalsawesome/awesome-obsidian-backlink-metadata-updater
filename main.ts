import { App, TFile, Plugin, Notice, PluginSettingTab, Setting, FuzzySuggestModal, TFolder, Modal, ButtonComponent } from 'obsidian';
import { BacklinkMetadataSettings, DEFAULT_SETTINGS, Rule } from './src/types';
import { DateExtractor } from './src/utils/date-extractor';
import { RuleEngine } from './src/engine/rule-engine';
import { BacklinkProcessor } from './src/processor/backlink-processor';

export default class BacklinkMetadataPlugin extends Plugin {
    settings: BacklinkMetadataSettings;
    private dateExtractor: DateExtractor;
    private ruleEngine: RuleEngine;
    private processor: BacklinkProcessor;
    private fileContentCache: Map<string, { signature: string; links: string[] }> = new Map();
    private stopped = false;
    private pendingCleanup = new Set<{ readonly source: TFile; readonly sourcePath: string; readonly eventPath: string; readonly targetPaths: readonly string[]; running?: Promise<void> }>();

    async onload() {
        await this.loadSettings();

        // Initialize components with settings
        this.dateExtractor = new DateExtractor(this.app, this.settings.options.dateFormat);
        this.ruleEngine = new RuleEngine(this.app);
        this.ruleEngine.setLogging(this.settings.options.enableLogging);
        this.processor = new BacklinkProcessor(this.app, this.dateExtractor, this.ruleEngine);

        // Register event handlers using onLayoutReady for better performance
        this.app.workspace.onLayoutReady(() => {
            if (this.stopped) return;
            this.registerEventHandlers();
            this.seedSourceCache();
        });

        // Add commands
        this.addCommands();

        // Add settings tab
        this.addSettingTab(new BacklinkMetadataSettingTab(this.app, this));
    }

    onunload() {
        this.stopped = true;
        this.processor?.cancelAllProcessing();
        this.fileContentCache.clear();
        this.pendingCleanup.clear();
    }

    /**
     * Sync component settings after a settings change.
     */
    private syncComponentSettings(): void {
        this.dateExtractor?.setDateFormat(this.settings.options.dateFormat);
        this.ruleEngine?.setLogging(this.settings.options.enableLogging);
        this.ruleEngine?.clearRegexCache();
        if (this.processor && !this.stopped) this.seedSourceCache();
    }

    private seedSourceCache(): void {
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (!this.fileContentCache.has(file.path) && this.shouldProcessFile(file)) this.cacheSource(file);
        }
    }

    private registerEventHandlers() {
        this.registerEvent(
            this.app.metadataCache.on('changed', (file: TFile) => {
                void this.handleFileModify(file).catch(error => console.error('Error updating backlink metadata:', error));
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath: string) => {
                if (file instanceof TFile) void this.handleFileRename(file, oldPath).catch(error => console.error('Error updating renamed source:', error));
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) void this.handleFileDelete(file).catch(error => console.error('Error cleaning deleted source:', error));
            })
        );
    }

    private cacheSource(file: TFile): { signature: string; links: string[] } {
        const links = this.processor.extractOutgoingLinks(file, this.settings.rules);
        const generatedFields = this.settings.rules.map(rule => rule.updateField);
        const sourceRules = this.settings.rules.filter(rule => rule.enabled && this.ruleEngine.matchesSourcePattern(rule, file));
        // Only inputs used by rules trigger automatic updates. Generated history and
        // duplicate backlink writes cannot keep reciprocal rules running forever.
        const snapshot = {
            links,
            signature: JSON.stringify([
                [...links].sort(),
                sourceRules.some(rule => rule.valueType === 'date' || rule.valueType === 'date_and_title') ? this.dateExtractor.extractDate(file, generatedFields) : null,
                sourceRules.some(rule => rule.valueType === 'date_and_title') ? this.dateExtractor.extractTitle(file, generatedFields) : null,
            ]),
        };
        const existing = this.fileContentCache.get(file.path);
        if (existing?.signature === snapshot.signature) return existing;
        this.fileContentCache.set(file.path, snapshot);
        return snapshot;
    }

    private queueCleanup(file: TFile, targetPaths: string[], sourcePath = file.path): void {
        if (this.stopped || !this.settings.options.updateOnDelete || !targetPaths.length) return;
        this.pendingCleanup.add({ source: { ...file, path: sourcePath } as TFile, sourcePath, eventPath: file.path, targetPaths: [...targetPaths] });
    }

    private async retryCleanup(path?: string): Promise<void> {
        for (const operation of [...this.pendingCleanup]) {
            if (this.stopped || !this.settings.options.updateOnDelete) return;
            if (!this.pendingCleanup.has(operation)) continue;
            if (path && operation.sourcePath !== path && operation.eventPath !== path && !operation.targetPaths.includes(path)) continue;
            if (!operation.running) {
                operation.running = this.processor.cleanupRemovedLinks(operation.source,
                    [...operation.targetPaths], this.settings.rules, this.settings.options, operation.sourcePath)
                    .then(completed => { if (completed) this.pendingCleanup.delete(operation); })
                    .catch(error => {
                        if (!this.stopped) new Notice(`Backlink cleanup failed for ${operation.sourcePath}. Run Retry pending backlink cleanup: ${error instanceof Error ? error.message : String(error)}`);
                    }).finally(() => { operation.running = undefined; });
            }
            await operation.running;
        }
    }

    private scheduleSource(file: TFile, snapshot: { signature: string; links: string[] }): void {
        const path = file.path;
        this.processor.scheduleProcessing(file, this.settings.rules, this.settings.options, error => {
            if (this.stopped) return;
            if (this.fileContentCache.get(path) === snapshot) snapshot.signature = '';
            new Notice(`Backlink update failed for ${path}. Edit the source or run Process current file to retry: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    private async handleFileModify(file: TFile) {
        if (this.stopped) return;
        if (!this.shouldProcessFile(file)) { await this.retryCleanup(file.path); return; }
        const path = file.path;
        const previous = this.fileContentCache.get(path);
        const current = this.cacheSource(file);
        const currentLinks = new Set(current.links);
        this.queueCleanup(file, previous?.links.filter(link => !currentLinks.has(link)) || [], path);
        await this.retryCleanup(path);
        if (!this.stopped && file.path === path && this.fileContentCache.get(path) === current && previous?.signature !== current.signature) {
            this.scheduleSource(file, current);
        }
    }

    private async handleFileRename(file: TFile, oldPath: string) {
        if (this.stopped) return;
        const path = file.path;
        const cached = this.fileContentCache.get(oldPath);
        this.fileContentCache.delete(oldPath);
        this.queueCleanup(file, cached?.links || [], oldPath);
        await this.retryCleanup(oldPath);
        if (!this.stopped && file.path === path && this.shouldProcessFile(file)) {
            this.scheduleSource(file, this.cacheSource(file));
        }
    }

    private async handleFileDelete(file: TFile) {
        if (this.stopped) return;
        const cached = this.fileContentCache.get(file.path);
        this.fileContentCache.delete(file.path);
        this.queueCleanup(file, cached?.links || []);
        await this.retryCleanup(file.path);
    }

    private shouldProcessFile(file: TFile): boolean {
        if (file.extension !== 'md') {
            return false;
        }

        return this.settings.rules.some(rule => {
            return rule.enabled && this.ruleEngine.validateRule(rule).isValid && this.ruleEngine.matchesSourcePattern(rule, file);
        });
    }

    private addCommands() {
        this.addCommand({
            id: 'retry-pending-backlink-cleanup',
            name: 'Retry pending backlink cleanup',
            callback: () => this.retryCleanup(),
        });
        this.addCommand({
            id: 'process-all-files',
            name: 'Process all files for backlink metadata',
            callback: async () => {
                await this.processAllFiles();
            }
        });

        this.addCommand({
            id: 'process-current-file',
            name: 'Process current file for backlink metadata',
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    this.seedSourceCache();
                    try {
                        await this.processor.processFile(activeFile, this.settings.rules, this.settings.options);
                        new Notice('Current file processed successfully');
                    } catch (error) {
                        new Notice(`Error processing current file: ${error instanceof Error ? error.message : String(error)}`);
                    }
                } else {
                    new Notice('No active file to process');
                }
            }
        });

        this.addCommand({
            id: 'validate-rules',
            name: 'Validate metadata update rules',
            callback: () => {
                this.validateRules();
            }
        });

        this.addCommand({
            id: 'bulk-update-metadata-from-backlinks',
            name: 'Bulk update metadata from backlinks',
            callback: async () => {
                await this.bulkUpdateMetadataFromBacklinks();
            }
        });
    }

    private async processAllFiles() {
        this.seedSourceCache();
        const notice = new Notice('Processing all files...', 0);
        let processed = 0;

        try {
            await this.processor.processAllFiles(
                this.settings.rules,
                this.settings.options,
                (current, totalFiles) => {
                    processed = current;
                    notice.setMessage(`Processing files: ${current}/${totalFiles}`);
                }
            );

            notice.hide();
            new Notice(this.stopped ? `Processing stopped after ${processed} files` : `Successfully processed ${processed} files`);
        } catch (error) {
            notice.hide();
            new Notice(`Error processing files: ${error instanceof Error ? error.message : String(error)}`);
            console.error('Error processing all files:', error);
        }
    }

    private validateRules() {
        const validation = this.ruleEngine.validateRuleSet(this.settings.rules);

        if (validation.isValid) {
            new Notice('All rules are valid');
        } else {
            new Notice(`Rule validation failed: ${validation.errors.join(', ')}`);
        }

        if (validation.warnings.length > 0) {
            new Notice(`Warnings: ${validation.warnings.join(', ')}`);
        }

        if (this.settings.options.enableLogging) {
            console.log('Rule validation result:', validation);
        }
    }

    private async bulkUpdateMetadataFromBacklinks() {
        this.seedSourceCache();
        const notice = new Notice('Scanning backlinks from source files...', 0);

        try {
            const allFiles = this.app.vault.getMarkdownFiles();

            // Deduplicate by path, not object reference
            const seenPaths = new Set<string>();
            const uniqueSourceFiles: TFile[] = [];

            for (const rule of this.settings.rules) {
                if (rule.enabled) {
                    for (const file of allFiles) {
                        if (!seenPaths.has(file.path) && this.ruleEngine.matchesSourcePattern(rule, file)) {
                            seenPaths.add(file.path);
                            uniqueSourceFiles.push(file);
                        }
                    }
                }
            }

            notice.setMessage(`Found ${uniqueSourceFiles.length} source files, scanning backlinks...`);

            let processedCount = 0;
            let failedCount = 0;
            let attemptedCount = 0;
            const BATCH_SIZE = 20;

            for (const sourceFile of uniqueSourceFiles) {
                if (this.stopped) break;
                attemptedCount++;
                try {
                    await this.processor.processFile(sourceFile, this.settings.rules, this.settings.options);
                    processedCount++;
                } catch (error) {
                    failedCount++;
                    console.warn(`Error processing source file ${sourceFile.path}:`, error);
                }

                // Yield to UI every batch
                if (attemptedCount % BATCH_SIZE === 0) {
                    notice.setMessage(`Processing: ${processedCount}/${uniqueSourceFiles.length} source files...`);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            notice.hide();
            new Notice(`Bulk update ${this.stopped ? 'stopped' : 'complete'}: processed ${processedCount} source files, ${failedCount} failed`);

        } catch (error) {
            notice.hide();
            new Notice(`Error during bulk update: ${error instanceof Error ? error.message : String(error)}`);
            console.error('Error in bulkUpdateMetadataFromBacklinks:', error);
        }
    }

    async loadSettings() {
        const saved = await this.loadData();
        this.settings = {
            ...DEFAULT_SETTINGS,
            rules: (Array.isArray(saved?.rules) ? saved.rules : DEFAULT_SETTINGS.rules).map((rule: Rule) => ({ ...rule })),
            options: {
                ...DEFAULT_SETTINGS.options,
                ...(saved?.options || {}),
            },
        };
    }

    setDateFormat(format: string): void {
        this.settings.options.dateFormat = format;
        this.dateExtractor?.setDateFormat(format);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.syncComponentSettings();
    }
}

class BacklinkMetadataSettingTab extends PluginSettingTab {
    plugin: BacklinkMetadataPlugin;
    private settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private ruleDrafts = new Map<string, Rule>();
    private savingRules = new Set<string>();

    constructor(app: App, plugin: BacklinkMetadataPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.plugin.register(() => this.flushSettingsSave());
    }

    /**
     * Debounced save for text inputs to avoid saving on every keystroke.
     */
    private debouncedSaveSettings(): void {
        if (this.settingsSaveTimer) {
            clearTimeout(this.settingsSaveTimer);
        }
        this.settingsSaveTimer = setTimeout(() => {
            this.flushSettingsSave();
        }, 500);
    }

    private flushSettingsSave(): void {
        if (this.settingsSaveTimer === null) return;
        clearTimeout(this.settingsSaveTimer);
        this.settingsSaveTimer = null;
        void this.saveOptions();
    }

    private async saveOptions(): Promise<void> {
        this.plugin.setDateFormat(this.plugin.settings.options.dateFormat);
        try {
            await this.plugin.saveSettings();
        } catch (error) {
            new Notice(`Options changed in memory but were not saved. Change an option again to retry before reloading: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    hide(): void {
        this.flushSettingsSave();
    }

    private focusRule(id?: string): void {
        const row = Array.from(this.containerEl.querySelectorAll<HTMLElement>('.rule-container'))
            .find(element => element.dataset.ruleId === id);
        (row?.querySelector<HTMLButtonElement>('button') || this.containerEl.querySelector<HTMLButtonElement>('.add-rule-button'))?.focus();
    }

    private redisplayAfterFailure(): void {
        const active = this.containerEl.ownerDocument.activeElement;
        const inside = active && this.containerEl.contains(active);
        const row = inside ? active.closest<HTMLElement>('.rule-container') : null;
        const controls = 'input, select, button';
        const index = inside ? Array.from((row || this.containerEl).querySelectorAll(controls)).indexOf(active) : -1;
        const ruleId = row?.dataset.ruleId;
        this.display();
        if (!inside) return;
        const replacementRow = ruleId ? Array.from(this.containerEl.querySelectorAll<HTMLElement>('.rule-container'))
            .find(element => element.dataset.ruleId === ruleId) : null;
        const replacement = ruleId && !replacementRow ? this.containerEl.querySelector<HTMLElement>('.add-rule-button')
            : (replacementRow || this.containerEl).querySelectorAll<HTMLElement>(controls)[index];
        replacement?.focus();
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('backlink-metadata-settings');

        // Plugin options section
        new Setting(containerEl).setName('Plugin Options').setHeading();

        new Setting(containerEl)
            .setName('Preserve history')
            .setDesc('Keep track of all metadata updates in history fields')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.options.preserveHistory)
                .onChange(async (value) => {
                    this.plugin.settings.options.preserveHistory = value;
                    await this.saveOptions();
                })
            );

        new Setting(containerEl)
            .setName('Update on delete')
            .setDesc('Remove generated source links when links or source notes are deleted; dates and history are preserved')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.options.updateOnDelete)
                .onChange(async (value) => {
                    this.plugin.settings.options.updateOnDelete = value;
                    await this.saveOptions();
                })
            );

        new Setting(containerEl)
            .setName('Date format')
            .setDesc('Format for date values (uses moment.js format)')
            .addText(text => text
                .setPlaceholder('YYYY-MM-DD')
                .setValue(this.plugin.settings.options.dateFormat)
                .onChange((value) => {
                    this.plugin.setDateFormat(value || 'YYYY-MM-DD');
                    this.debouncedSaveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Debounce delay (ms)')
            .setDesc('Wait time before processing file changes (100–30000)')
            .addText(text => {
                text.setPlaceholder('1000')
                    .setValue(this.plugin.settings.options.debounceMs.toString())
                    .onChange((value) => {
                        const parsed = parseInt(value);
                        const numValue = isNaN(parsed) ? 1000 : Math.max(100, Math.min(parsed, 30000));
                        this.plugin.settings.options.debounceMs = numValue;
                        this.debouncedSaveSettings();
                    });
                text.inputEl.setAttribute('type', 'number');
                text.inputEl.setAttribute('min', '100');
                text.inputEl.setAttribute('max', '30000');
                text.inputEl.setAttribute('inputmode', 'numeric');
            });

        new Setting(containerEl)
            .setName('Enable logging')
            .setDesc('Enable debug logging to console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.options.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.options.enableLogging = value;
                    await this.saveOptions();
                })
            );

        // Rules section
        new Setting(containerEl).setName('Metadata Update Rules').setHeading();

        // Add rule button
        new Setting(containerEl)
            .setName('Add new rule')
            .setDesc('Create a new metadata update rule')
            .addButton(button => button
                .setButtonText('Add Rule')
                .setClass('add-rule-button')
                .onClick(() => {
                    this.addNewRule();
                })
            );

        // Display existing rules in a semantic list
        const rulesContainer = containerEl.createDiv('rules-list');
        rulesContainer.setAttribute('role', 'list');
        rulesContainer.setAttribute('aria-label', 'Metadata update rules');

        this.plugin.settings.rules.forEach((rule, index) => {
            this.displayRule(rulesContainer, rule, index);
        });
    }

    private displayRule(containerEl: HTMLElement, rule: Rule, index: number) {
        const ruleContainer = containerEl.createDiv('rule-container');
        ruleContainer.setAttribute('role', 'listitem');
        ruleContainer.dataset.ruleId = rule.id;

        const displaySource = rule.sourcePattern.endsWith('/*')
            ? rule.sourcePattern.slice(0, -2)
            : rule.sourcePattern;

        new Setting(ruleContainer)
            .setName(rule.name || `Rule ${index + 1}`)
            .setDesc(`${displaySource} → ${rule.updateField}`)
            .addButton(button => {
                button.setButtonText('Edit')
                    .onClick(() => {
                        this.editRule(ruleContainer, index);
                    });
                button.buttonEl.setAttribute('aria-label', `Edit rule: ${rule.name || `Rule ${index + 1}`}`);
            })
            .addButton(button => {
                button.setButtonText('Delete')
                    .setClass('mod-warning')
                    .onClick(() => {
                        this.confirmDeleteRule(index, rule.name || `Rule ${index + 1}`);
                    });
                button.buttonEl.setAttribute('aria-label', `Delete rule: ${rule.name || `Rule ${index + 1}`}`);
            });
        const draft = this.ruleDrafts.get(rule.id);
        if (draft) this.renderRuleEditor(ruleContainer, draft);
    }

    private addNewRule() {
        const newRule: Rule = {
            id: `rule-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            name: 'New Rule',
            sourcePattern: 'Daily Notes/*',
            targetTag: '#example',
            updateField: 'lastSeen',
            valueType: 'date' as const,
            priority: 1,
            enabled: true
        };

        this.plugin.settings.rules.push(newRule);
        void this.plugin.saveSettings().catch(error => {
            const index = this.plugin.settings.rules.indexOf(newRule);
            if (index !== -1) this.plugin.settings.rules.splice(index, 1);
            this.redisplayAfterFailure();
            new Notice(`Could not add rule. Retry Add Rule; existing drafts are preserved: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.display();
        this.focusRule(newRule.id);
    }

    private editRule(ruleContainer: HTMLElement, index: number) {
        const rule = this.plugin.settings.rules[index];

        if (ruleContainer.querySelector('.rule-editor')) {
            return;
        }

        const draft = { ...rule };
        this.ruleDrafts.set(rule.id, draft);
        this.renderRuleEditor(ruleContainer, draft);
    }

    private renderRuleEditor(ruleContainer: HTMLElement, rule: Rule) {
        // Remove any existing editor before re-rendering
        const existing = ruleContainer.querySelector('.rule-editor');
        if (existing) existing.remove();

        const editorContainer = ruleContainer.createDiv('rule-editor');
        editorContainer.setAttribute('role', 'region');
        editorContainer.setAttribute('aria-label', `Editing rule: ${rule.name}`);

        // Live region for screen reader announcements
        const liveRegion = ruleContainer.querySelector<HTMLElement>('.sr-live-region') || ruleContainer.createDiv('sr-live-region');
        liveRegion.setAttribute('aria-live', 'polite');
        liveRegion.setAttribute('role', 'status');

        // Rule Name
        new Setting(editorContainer)
            .setName('Rule Name')
            .addText(text => text
                .setValue(rule.name)
                .onChange((value) => {
                    rule.name = value;
                })
            );

        // Source Pattern
        new Setting(editorContainer)
            .setName('Source Pattern')
            .setDesc('Glob pattern for files that trigger updates (use Browse folders)')
            .addText(text => {
                const displayValue = rule.sourcePattern.endsWith('/*')
                    ? rule.sourcePattern.slice(0, -2)
                    : rule.sourcePattern;

                const textEl = text
                    .setValue(displayValue)
                    .onChange((value) => {
                        rule.sourcePattern = value;
                    });

                const controls = textEl.inputEl.parentElement;
                if (!controls) return textEl;
                const browse = new ButtonComponent(controls)
                    .setButtonText('Browse folders')
                    .onClick(() => {
                        new FolderSuggestModal(this.plugin.app, (folder) => {
                            rule.sourcePattern = folder.path ? `${folder.path}/*` : '**';
                            textEl.setValue(folder.path || '');
                        }, () => browse.buttonEl.focus()).open();
                    });
                browse.buttonEl.setAttribute('aria-label', 'Browse source folders');

                return textEl;
            });

        // Target Type (Tag or Folder)
        new Setting(editorContainer)
            .setName('Target Type')
            .addDropdown(dropdown => {
                dropdown.selectEl.dataset.control = 'target-type';
                dropdown
                .addOption('tag', 'Tag')
                .addOption('folder', 'Folder')
                .setValue(rule.targetTag ? 'tag' : 'folder')
                .onChange((value) => {
                    if (value === 'tag') {
                        rule.targetTag = rule.targetFolder || '#example';
                        rule.targetFolder = undefined;
                    } else {
                        rule.targetFolder = rule.targetTag?.replace('#', '') || 'Example';
                        rule.targetTag = undefined;
                    }
                    // Re-render the entire editor to swap the target field cleanly
                    this.renderRuleEditor(ruleContainer, rule);
                    ruleContainer.querySelector<HTMLSelectElement>('[data-control=target-type]')?.focus();
                    liveRegion.textContent = `Target type changed to ${value}.`;
                });
            });

        // Target Value
        new Setting(editorContainer)
            .setName(rule.targetTag ? 'Target Tag' : 'Target Folder')
            .setDesc(rule.targetTag ? 'Tag to match (e.g., "#movie")' : 'Folder path to match (use Browse folders)')
            .addText(text => {
                let displayValue = rule.targetTag || rule.targetFolder || '';
                if (!rule.targetTag && displayValue.endsWith('/*')) {
                    displayValue = displayValue.slice(0, -2);
                }

                const textComponent = text
                    .setValue(displayValue)
                    .onChange((value) => {
                        if (rule.targetTag !== undefined) {
                            rule.targetTag = value;
                            rule.targetFolder = undefined;
                        } else {
                            rule.targetFolder = value;
                            rule.targetTag = undefined;
                        }
                    });

                if (rule.targetFolder !== undefined) {
                    const controls = textComponent.inputEl.parentElement;
                    if (!controls) return textComponent;
                    const browse = new ButtonComponent(controls)
                        .setButtonText('Browse folders')
                        .onClick(() => {
                            new FolderSuggestModal(this.plugin.app, (folder) => {
                                rule.targetFolder = folder.path ? `${folder.path}/*` : '**';
                                rule.targetTag = undefined;
                                textComponent.setValue(folder.path || '');
                            }, () => browse.buttonEl.focus()).open();
                        });
                    browse.buttonEl.setAttribute('aria-label', 'Browse target folders');
                }

                return textComponent;
            });

        // Update Field
        new Setting(editorContainer)
            .setName('Update Field')
            .setDesc('Frontmatter field to update (supports hyphens, e.g., "last-watched")')
            .addText(text => text
                .setValue(rule.updateField)
                .onChange((value) => {
                    rule.updateField = value;
                })
            );

        // Value Type
        new Setting(editorContainer)
            .setName('Value Type')
            .addDropdown(dropdown => dropdown
                .addOption('date', 'Date')
                .addOption('date_and_title', 'Date and Title')
                .addOption('append_link', 'Append Link')
                .addOption('append_unique_link', 'Append Unique Link')
                .addOption('replace_link', 'Replace Link')
                .setValue(rule.valueType)
                .onChange((value) => {
                    rule.valueType = value as Rule['valueType'];
                })
            );

        // Priority
        new Setting(editorContainer)
            .setName('Priority')
            .setDesc('Execution order (1–100): lower numbers run first; later rules may overwrite earlier values')
            .addText(text => {
                text.setValue(rule.priority.toString())
                    .onChange((value) => {
                        const parsed = parseInt(value);
                        rule.priority = isNaN(parsed) ? 1 : Math.max(1, Math.min(parsed, 100));
                    });
                text.inputEl.setAttribute('type', 'number');
                text.inputEl.setAttribute('min', '1');
                text.inputEl.setAttribute('max', '100');
                text.inputEl.setAttribute('inputmode', 'numeric');
            });

        // Enabled Toggle
        new Setting(editorContainer)
            .setName('Enabled')
            .addToggle(toggle => toggle
                .setValue(rule.enabled)
                .onChange((value) => {
                    rule.enabled = value;
                })
            );

        // Preserve History Toggle
        new Setting(editorContainer)
            .setName('Preserve History')
            .setDesc('Track update history for this rule (overrides global setting)')
            .addToggle(toggle => toggle
                .setValue(rule.preserveHistory !== undefined ? rule.preserveHistory : this.plugin.settings.options.preserveHistory)
                .onChange((value) => {
                    rule.preserveHistory = value;
                })
            );

        // Action buttons
        const buttonContainer = editorContainer.createDiv('rule-editor-actions');

        const saveButton = buttonContainer.createEl('button', { text: 'Save' });
        saveButton.setAttribute('aria-label', `Save rule: ${rule.name}`);
        saveButton.onclick = async () => {
            if (this.savingRules.has(rule.id)) return;
            const validation = this.validateRuleInputs(rule);
            if (!validation.isValid) {
                new Notice(`Validation error: ${validation.errors.join(', ')}`);
                return;
            }

            const ruleIndex = this.plugin.settings.rules.findIndex(r => r.id === rule.id);
            if (ruleIndex === -1) return;
            const previous = this.plugin.settings.rules[ruleIndex];
            const replacement = { ...rule };
            this.plugin.settings.rules[ruleIndex] = replacement;
            const savedDraft = JSON.stringify(rule);
            const wasFocused = saveButton.ownerDocument.activeElement === saveButton;
            this.savingRules.add(rule.id);
            saveButton.disabled = true;
            try {
                await this.plugin.saveSettings();
            } catch (error) {
                const currentIndex = this.plugin.settings.rules.findIndex(r => r.id === rule.id);
                if (this.plugin.settings.rules[currentIndex] === replacement) this.plugin.settings.rules[currentIndex] = previous;
                saveButton.disabled = false;
                if (wasFocused && saveButton.ownerDocument.activeElement === saveButton.ownerDocument.body) saveButton.focus();
                new Notice(`Could not save rule: ${error instanceof Error ? error.message : String(error)}`);
                return;
            } finally {
                this.savingRules.delete(rule.id);
                saveButton.disabled = false;
            }
            if (!this.plugin.settings.rules.includes(replacement) || this.ruleDrafts.get(rule.id) !== rule
                || JSON.stringify(rule) !== savedDraft) return;
            this.ruleDrafts.delete(rule.id);
            editorContainer.remove();
            this.display();
            this.focusRule(rule.id);
            new Notice('Rule saved successfully');
        };

        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.setAttribute('aria-label', `Cancel editing rule: ${rule.name}`);
        cancelButton.onclick = () => {
            this.ruleDrafts.delete(rule.id);
            editorContainer.remove();
            this.focusRule(rule.id);
        };
    }

    private validateRuleInputs(rule: Rule): { isValid: boolean; errors: string[] } {
        const validation = new RuleEngine(this.plugin.app).validateRule(rule);
        const errors = [...validation.errors];
        if (!rule.name.trim()) errors.push('Rule name is required');
        if (!rule.sourcePattern.trim()) errors.push('Source pattern is required');
        if (!rule.targetTag && !rule.targetFolder) errors.push('Either target tag or target folder must be specified');
        if (rule.targetTag && !rule.targetTag.startsWith('#')) errors.push('Target tag must start with #');
        return { isValid: errors.length === 0, errors };
    }

    private confirmDeleteRule(index: number, ruleName: string) {
        const rule = this.plugin.settings.rules[index];
        const modal = new ConfirmDeleteModal(this.plugin.app, ruleName, async () => {
            const currentIndex = this.plugin.settings.rules.indexOf(rule);
            if (currentIndex === -1) return;
            this.plugin.settings.rules.splice(currentIndex, 1);
            this.display();
            this.focusRule(this.plugin.settings.rules[currentIndex]?.id);
            try {
                await this.plugin.saveSettings();
            } catch (error) {
                if (!this.plugin.settings.rules.some(current => current.id === rule.id)) {
                    this.plugin.settings.rules.splice(Math.min(currentIndex, this.plugin.settings.rules.length), 0, rule);
                }
                this.redisplayAfterFailure();
                new Notice(`Could not delete rule. Retry Delete; drafts are preserved: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            if (!this.plugin.settings.rules.some(current => current.id === rule.id)) this.ruleDrafts.delete(rule.id);
        });
        modal.open();
    }


}

class ConfirmDeleteModal extends Modal {
    private ruleName: string;
    private onConfirm: () => Promise<void>;

    constructor(app: App, ruleName: string, onConfirm: () => Promise<void>) {
        super(app);
        this.ruleName = ruleName;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('backlink-metadata-settings');
        contentEl.createEl('h3', { text: 'Delete Rule' });
        contentEl.createEl('p', { text: `Are you sure you want to delete "${this.ruleName}"? This cannot be undone.` });

        const buttonContainer = contentEl.createDiv('confirm-delete-actions');

        const deleteBtn = buttonContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
        deleteBtn.onclick = () => {
            void this.onConfirm().catch(error => {
                new Notice(`Could not delete rule. Reopen settings and retry: ${error instanceof Error ? error.message : String(error)}`);
            });
            this.close();
        };

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => {
            this.close();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    constructor(app: App, private onChoose: (folder: TFolder) => void, private onDismiss: () => void) {
        super(app);
        this.setPlaceholder('Choose a folder...');
    }

    onClose(): void {
        super.onClose();
        this.onDismiss();
    }

    getItems(): TFolder[] {
        return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder);
    }

    getItemText(folder: TFolder): string {
        return folder.path || '/';
    }

    onChooseItem(folder: TFolder): void {
        this.onChoose(folder);
        this.close();
    }
}
