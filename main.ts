import { App, TFile, Plugin, Notice, PluginSettingTab, Setting, FuzzySuggestModal, TFolder, Modal } from 'obsidian';
import { BacklinkMetadataSettings, DEFAULT_SETTINGS, Rule } from './src/types';
import { DateExtractor } from './src/utils/date-extractor';
import { RuleEngine } from './src/engine/rule-engine';
import { BacklinkProcessor } from './src/processor/backlink-processor';

export default class BacklinkMetadataPlugin extends Plugin {
    settings: BacklinkMetadataSettings;
    private dateExtractor: DateExtractor;
    private ruleEngine: RuleEngine;
    private processor: BacklinkProcessor;
    private fileContentCache: Map<string, { contentHash: number; links: string[] }> = new Map();

    async onload() {
        await this.loadSettings();

        // Initialize components with settings
        this.dateExtractor = new DateExtractor(this.app, this.settings.options.dateFormat);
        this.ruleEngine = new RuleEngine(this.app);
        this.ruleEngine.setLogging(this.settings.options.enableLogging);
        this.processor = new BacklinkProcessor(this.app, this.dateExtractor, this.ruleEngine);

        // Register event handlers using onLayoutReady for better performance
        this.app.workspace.onLayoutReady(() => {
            this.registerEventHandlers();
        });

        // Add commands
        this.addCommands();

        // Add settings tab
        this.addSettingTab(new BacklinkMetadataSettingTab(this.app, this));
    }

    onunload() {
        this.processor?.cancelAllProcessing();
        this.fileContentCache.clear();
    }

    /**
     * Sync component settings after a settings change.
     */
    private syncComponentSettings(): void {
        this.dateExtractor?.setDateFormat(this.settings.options.dateFormat);
        this.ruleEngine?.setLogging(this.settings.options.enableLogging);
        this.ruleEngine?.clearRegexCache();
    }

    private registerEventHandlers() {
        this.registerEvent(
            this.app.vault.on('modify', (file: TFile) => {
                this.handleFileModify(file);
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file: TFile, oldPath: string) => {
                this.handleFileRename(file, oldPath);
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file: TFile) => {
                this.handleFileDelete(file);
            })
        );
    }

    /**
     * Simple string hash for content comparison (avoids storing full content).
     */
    private hashContent(content: string): number {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const chr = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    }

    private async handleFileModify(file: TFile) {
        if (!this.shouldProcessFile(file)) {
            return;
        }

        // Use processor's extractOutgoingLinks to avoid duplicated logic
        const currentContent = await this.app.vault.read(file);
        const currentHash = this.hashContent(currentContent);
        const currentLinks = this.processor.extractOutgoingLinks(file);

        const cached = this.fileContentCache.get(file.path);

        if (cached) {
            const contentChanged = cached.contentHash !== currentHash;
            const linksChanged = !this.arraysEqual(cached.links, currentLinks);

            if (!contentChanged) {
                return;
            }

            if (!linksChanged && currentLinks.length === 0) {
                return;
            }

            if (linksChanged) {
                const newLinks = currentLinks.filter(link => !cached.links.includes(link));
                const removedLinks = cached.links.filter(link => !currentLinks.includes(link));

                if (newLinks.length === 0 && removedLinks.length === 0) {
                    this.fileContentCache.set(file.path, { contentHash: currentHash, links: currentLinks });
                    return;
                }
            }
        }

        this.fileContentCache.set(file.path, { contentHash: currentHash, links: currentLinks });

        // Schedule processing with debouncing
        this.processor.scheduleProcessing(file, this.settings.rules, this.settings.options);
    }

    private arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;

        const sortedA = [...a].sort();
        const sortedB = [...b].sort();

        return sortedA.every((val, index) => val === sortedB[index]);
    }

    private async handleFileRename(file: TFile, oldPath: string) {
        if (this.settings.options.enableLogging) {
            console.log(`File renamed: ${oldPath} -> ${file.path}`);
        }

        const cached = this.fileContentCache.get(oldPath);
        if (cached) {
            this.fileContentCache.delete(oldPath);
            this.fileContentCache.set(file.path, cached);
        }

        // Route through debounce for consistency (avoids cascade on bulk renames)
        this.processor.scheduleProcessing(file, this.settings.rules, this.settings.options);
    }

    private async handleFileDelete(file: TFile) {
        if (this.settings.options.enableLogging) {
            console.log(`File deleted: ${file.path}`);
        }

        this.fileContentCache.delete(file.path);
    }

    private shouldProcessFile(file: TFile): boolean {
        if (file.extension !== 'md') {
            return false;
        }

        return this.settings.rules.some(rule => {
            return rule.enabled && this.ruleEngine.matchesSourcePattern(rule, file);
        });
    }

    private addCommands() {
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
                    await this.processor.processFile(activeFile, this.settings.rules, this.settings.options);
                    new Notice('Current file processed successfully');
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
            new Notice(`Successfully processed ${processed} files`);
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
            const BATCH_SIZE = 20;

            for (const sourceFile of uniqueSourceFiles) {
                try {
                    await this.processor.processFile(sourceFile, this.settings.rules, this.settings.options);
                    processedCount++;
                } catch (error) {
                    console.warn(`Error processing source file ${sourceFile.path}:`, error);
                }

                // Yield to UI every batch
                if (processedCount % BATCH_SIZE === 0) {
                    notice.setMessage(`Processing: ${processedCount}/${uniqueSourceFiles.length} source files...`);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            notice.hide();
            new Notice(`Bulk update complete: processed ${processedCount} source files`);

        } catch (error) {
            notice.hide();
            new Notice(`Error during bulk update: ${error instanceof Error ? error.message : String(error)}`);
            console.error('Error in bulkUpdateMetadataFromBacklinks:', error);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.syncComponentSettings();
    }
}

class BacklinkMetadataSettingTab extends PluginSettingTab {
    plugin: BacklinkMetadataPlugin;

    constructor(app: App, plugin: BacklinkMetadataPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Plugin options section
        new Setting(containerEl).setName('Plugin Options').setHeading();

        new Setting(containerEl)
            .setName('Preserve history')
            .setDesc('Keep track of all metadata updates in history fields')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.options.preserveHistory)
                .onChange(async (value) => {
                    this.plugin.settings.options.preserveHistory = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Update on delete')
            .setDesc('Clean up metadata when links are removed')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.options.updateOnDelete)
                .onChange(async (value) => {
                    this.plugin.settings.options.updateOnDelete = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Date format')
            .setDesc('Format for date values (uses moment.js format)')
            .addText(text => text
                .setPlaceholder('YYYY-MM-DD')
                .setValue(this.plugin.settings.options.dateFormat)
                .onChange(async (value) => {
                    this.plugin.settings.options.dateFormat = value || 'YYYY-MM-DD';
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Debounce delay (ms)')
            .setDesc('Wait time before processing file changes (100–30000)')
            .addText(text => {
                text.setPlaceholder('1000')
                    .setValue(this.plugin.settings.options.debounceMs.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value);
                        const numValue = isNaN(parsed) ? 1000 : Math.max(100, Math.min(parsed, 30000));
                        this.plugin.settings.options.debounceMs = numValue;
                        await this.plugin.saveSettings();
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
                    await this.plugin.saveSettings();
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
        this.plugin.saveSettings();
        this.display();
    }

    private editRule(ruleContainer: HTMLElement, index: number) {
        const rule = this.plugin.settings.rules[index];

        if (ruleContainer.querySelector('.rule-editor')) {
            return;
        }

        const editorContainer = ruleContainer.createDiv('rule-editor');
        editorContainer.setAttribute('role', 'region');
        editorContainer.setAttribute('aria-label', `Editing rule: ${rule.name}`);

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
            .setDesc('Glob pattern for files that trigger updates (click to browse folders)')
            .addText(text => {
                const displayValue = rule.sourcePattern.endsWith('/*')
                    ? rule.sourcePattern.slice(0, -2)
                    : rule.sourcePattern;

                const textEl = text
                    .setValue(displayValue)
                    .onChange((value) => {
                        rule.sourcePattern = value;
                    });

                textEl.inputEl.style.cursor = 'pointer';
                textEl.inputEl.setAttribute('aria-haspopup', 'dialog');
                textEl.inputEl.addEventListener('click', () => {
                    const modal = new FolderSuggestModal(this.plugin.app, (folder) => {
                        const pattern = folder.path ? `${folder.path}/*` : '*';
                        rule.sourcePattern = pattern;
                        textEl.setValue(folder.path || '');
                    });
                    modal.open();
                });

                return textEl;
            });

        // Target Type (Tag or Folder)
        new Setting(editorContainer)
            .setName('Target Type')
            .addDropdown(dropdown => dropdown
                .addOption('tag', 'Tag')
                .addOption('folder', 'Folder')
                .setValue(rule.targetTag ? 'tag' : 'folder')
                .onChange((value) => {
                    this.updateTargetType(editorContainer, rule, value);
                })
            );

        // Target Value
        new Setting(editorContainer)
            .setName(rule.targetTag ? 'Target Tag' : 'Target Folder')
            .setDesc(rule.targetTag ? 'Tag to match (e.g., "#movie")' : 'Folder path to match (click to browse folders)')
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
                    textComponent.inputEl.style.cursor = 'pointer';
                    textComponent.inputEl.setAttribute('aria-haspopup', 'dialog');
                    textComponent.inputEl.addEventListener('click', () => {
                        const modal = new FolderSuggestModal(this.plugin.app, (folder) => {
                            const pattern = folder.path ? `${folder.path}/*` : '*';
                            rule.targetFolder = pattern;
                            rule.targetTag = undefined;
                            textComponent.setValue(folder.path || '');
                        });
                        modal.open();
                    });
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
                    rule.valueType = value as any;
                })
            );

        // Priority
        new Setting(editorContainer)
            .setName('Priority')
            .setDesc('Lower numbers = higher priority (1–100)')
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
            const validation = this.validateRuleInputs(rule);
            if (!validation.isValid) {
                new Notice(`Validation error: ${validation.errors.join(', ')}`);
                return;
            }

            const ruleIndex = this.plugin.settings.rules.findIndex(r => r.id === rule.id);
            if (ruleIndex !== -1) {
                this.plugin.settings.rules[ruleIndex] = { ...rule };
            }

            await this.plugin.saveSettings();
            editorContainer.remove();
            this.display();
            new Notice('Rule saved successfully');
        };

        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.setAttribute('aria-label', `Cancel editing rule: ${rule.name}`);
        cancelButton.onclick = () => {
            editorContainer.remove();
        };
    }

    private updateTargetType(editorContainer: HTMLElement, rule: Rule, targetType: string) {
        if (targetType === 'tag') {
            rule.targetTag = rule.targetFolder || '#example';
            rule.targetFolder = undefined;
        } else {
            rule.targetFolder = rule.targetTag?.replace('#', '') || 'Example';
            rule.targetTag = undefined;
        }

        const targetValueSetting = editorContainer.querySelector('.setting-item:nth-of-type(4)') as HTMLElement;
        if (targetValueSetting) {
            const nameEl = targetValueSetting.querySelector('.setting-item-name');
            const descEl = targetValueSetting.querySelector('.setting-item-description');
            const inputEl = targetValueSetting.querySelector('input') as HTMLInputElement;

            if (nameEl && descEl && inputEl) {
                nameEl.textContent = targetType === 'tag' ? 'Target Tag' : 'Target Folder';
                descEl.textContent = targetType === 'tag' ? 'Tag to match (e.g., "#movie")' : 'Folder path to match (click to browse folders)';
                inputEl.value = rule.targetTag || rule.targetFolder || '';
            }

            if (targetType === 'folder') {
                inputEl.style.cursor = 'pointer';
                const newInputEl = inputEl.cloneNode(true) as HTMLInputElement;
                inputEl.replaceWith(newInputEl);

                newInputEl.setAttribute('aria-haspopup', 'dialog');
                newInputEl.addEventListener('click', () => {
                    const modal = new FolderSuggestModal(this.plugin.app, (folder) => {
                        const pattern = folder.path ? `${folder.path}/*` : '*';
                        rule.targetFolder = pattern;
                        rule.targetTag = undefined;
                        newInputEl.value = pattern;
                    });
                    modal.open();
                });

                newInputEl.addEventListener('input', (e) => {
                    rule.targetFolder = (e.target as HTMLInputElement).value;
                    rule.targetTag = undefined;
                });

                // Restore focus after clone
                newInputEl.focus();
            } else {
                inputEl.style.cursor = 'text';
                const newInputEl = inputEl.cloneNode(true) as HTMLInputElement;
                inputEl.replaceWith(newInputEl);

                newInputEl.removeAttribute('aria-haspopup');
                newInputEl.addEventListener('input', (e) => {
                    rule.targetTag = (e.target as HTMLInputElement).value;
                    rule.targetFolder = undefined;
                });

                // Restore focus after clone
                newInputEl.focus();
            }

            // Announce the change via a live region
            let liveRegion = editorContainer.querySelector('.sr-live-region') as HTMLElement;
            if (!liveRegion) {
                liveRegion = editorContainer.createEl('div', { cls: 'sr-live-region' });
                liveRegion.setAttribute('aria-live', 'polite');
                liveRegion.setAttribute('role', 'status');
                liveRegion.style.position = 'absolute';
                liveRegion.style.width = '1px';
                liveRegion.style.height = '1px';
                liveRegion.style.overflow = 'hidden';
                liveRegion.style.clip = 'rect(0, 0, 0, 0)';
            }
            liveRegion.textContent = `Target type changed to ${targetType}.`;
        }
    }

    private validateRuleInputs(rule: Rule): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (!rule.name || rule.name.trim() === '') {
            errors.push('Rule name is required');
        }

        if (!rule.sourcePattern || rule.sourcePattern.trim() === '') {
            errors.push('Source pattern is required');
        }

        if (!rule.targetTag && !rule.targetFolder) {
            errors.push('Either target tag or target folder must be specified');
        }

        if (rule.targetTag && !rule.targetTag.startsWith('#')) {
            errors.push('Target tag must start with #');
        }

        if (!rule.updateField || rule.updateField.trim() === '') {
            errors.push('Update field is required');
        }

        if (rule.priority < 1) {
            errors.push('Priority must be at least 1');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    private confirmDeleteRule(index: number, ruleName: string) {
        const modal = new ConfirmDeleteModal(this.plugin.app, ruleName, () => {
            this.plugin.settings.rules.splice(index, 1);
            this.plugin.saveSettings();
            this.display();
        });
        modal.open();
    }

    private deleteRule(index: number) {
        this.plugin.settings.rules.splice(index, 1);
        this.plugin.saveSettings();
        this.display();
    }
}

class ConfirmDeleteModal extends Modal {
    private ruleName: string;
    private onConfirm: () => void;

    constructor(app: App, ruleName: string, onConfirm: () => void) {
        super(app);
        this.ruleName = ruleName;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Delete Rule' });
        contentEl.createEl('p', { text: `Are you sure you want to delete "${this.ruleName}"? This cannot be undone.` });

        const buttonContainer = contentEl.createDiv('confirm-delete-actions');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.marginTop = '16px';

        const deleteBtn = buttonContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
        deleteBtn.onclick = () => {
            this.onConfirm();
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
    constructor(app: App, private onChoose: (folder: TFolder) => void) {
        super(app);
        this.setPlaceholder('Choose a folder...');
    }

    getItems(): TFolder[] {
        return this.app.vault.getAllFolders();
    }

    getItemText(folder: TFolder): string {
        return folder.path || '/';
    }

    onChooseItem(folder: TFolder): void {
        this.onChoose(folder);
        this.close();
    }
}
