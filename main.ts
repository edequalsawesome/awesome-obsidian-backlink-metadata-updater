import { App, TFile, Plugin, Notice, PluginSettingTab, Setting, FuzzySuggestModal, TFolder } from 'obsidian';
import { BacklinkMetadataSettings, DEFAULT_SETTINGS } from './src/types';
import { DateExtractor } from './src/utils/date-extractor';
import { RuleEngine } from './src/engine/rule-engine';
import { BacklinkProcessor } from './src/processor/backlink-processor';

export default class BacklinkMetadataPlugin extends Plugin {
    settings: BacklinkMetadataSettings;
    private dateExtractor: DateExtractor;
    private ruleEngine: RuleEngine;
    private processor: BacklinkProcessor;
    private fileContentCache: Map<string, { content: string; links: string[] }> = new Map();

    async onload() {
        await this.loadSettings();
        
        console.log('Backlink Metadata Plugin loading with settings:', this.settings);
        
        // Initialize components
        this.dateExtractor = new DateExtractor(this.app);
        this.ruleEngine = new RuleEngine(this.app);
        this.processor = new BacklinkProcessor(this.app, this.dateExtractor, this.ruleEngine);
        
        // Register event handlers using onLayoutReady for better performance
        this.app.workspace.onLayoutReady(() => {
            console.log('Workspace layout ready, registering event handlers');
            this.registerEventHandlers();
        });
        
        // Add commands
        this.addCommands();
        
        // Add settings tab
        this.addSettingTab(new BacklinkMetadataSettingTab(this.app, this));
        
        console.log('Backlink Metadata Plugin loaded successfully');
    }

    onunload() {
        // Cancel any pending processing
        this.processor?.cancelAllProcessing();
    }

    private registerEventHandlers() {
        // File modification handler
        this.registerEvent(
            this.app.vault.on('modify', (file: TFile) => {
                this.handleFileModify(file);
            })
        );

        // File rename handler  
        this.registerEvent(
            this.app.vault.on('rename', (file: TFile, oldPath: string) => {
                this.handleFileRename(file, oldPath);
            })
        );

        // File delete handler
        this.registerEvent(
            this.app.vault.on('delete', (file: TFile) => {
                this.handleFileDelete(file);
            })
        );
    }

    private async handleFileModify(file: TFile) {
        console.log(`File modified: ${file.path}`);
        
        if (!this.shouldProcessFile(file)) {
            console.log(`File ${file.path} should not be processed`);
            return;
        }

        // Get current content and links
        const currentContent = await this.app.vault.read(file);
        const currentLinks = this.extractFileLinks(file);
        
        // Get cached content and links
        const cached = this.fileContentCache.get(file.path);
        
        // Check if content or links actually changed
        if (cached) {
            const contentChanged = cached.content !== currentContent;
            const linksChanged = !this.arraysEqual(cached.links, currentLinks);
            
            console.log(`File ${file.path}: contentChanged=${contentChanged}, linksChanged=${linksChanged}`);
            
            // Only process if content changed AND links are involved
            if (!contentChanged) {
                console.log(`File ${file.path}: Only metadata changed, skipping processing`);
                return;
            }
            
            if (!linksChanged && currentLinks.length === 0) {
                console.log(`File ${file.path}: Content changed but no links present, skipping processing`);
                return;
            }
            
            // If links changed, we want to know which ones are new
            if (linksChanged) {
                const newLinks = currentLinks.filter(link => !cached.links.includes(link));
                const removedLinks = cached.links.filter(link => !currentLinks.includes(link));
                
                console.log(`File ${file.path}: New links: ${newLinks.length}, Removed links: ${removedLinks.length}`);
                
                if (newLinks.length === 0 && removedLinks.length === 0) {
                    console.log(`File ${file.path}: Link positions changed but no new/removed links, skipping processing`);
                    // Update cache but don't process
                    this.fileContentCache.set(file.path, { content: currentContent, links: currentLinks });
                    return;
                }
            }
        }
        
        // Update cache
        this.fileContentCache.set(file.path, { content: currentContent, links: currentLinks });
        
        console.log(`File ${file.path} will be processed`);

        // Schedule processing with debouncing
        this.processor.scheduleProcessing(file, this.settings.rules, this.settings.options);
    }

    private extractFileLinks(file: TFile): string[] {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.links) {
            return [];
        }

        const links: string[] = [];
        for (const link of cache.links) {
            const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
            if (resolvedFile && resolvedFile instanceof TFile) {
                links.push(resolvedFile.path);
            }
        }
        
        return [...new Set(links)]; // Remove duplicates and sort for consistent comparison
    }

    private arraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        
        // Sort both arrays for consistent comparison
        const sortedA = [...a].sort();
        const sortedB = [...b].sort();
        
        return sortedA.every((val, index) => val === sortedB[index]);
    }

    private async handleFileRename(file: TFile, oldPath: string) {
        if (this.settings.options.enableLogging) {
            console.log(`File renamed: ${oldPath} -> ${file.path}`);
        }

        // Update cache with new path
        const cached = this.fileContentCache.get(oldPath);
        if (cached) {
            this.fileContentCache.delete(oldPath);
            this.fileContentCache.set(file.path, cached);
        }

        // Process the renamed file
        await this.processor.processFile(file, this.settings.rules, this.settings.options);
    }

    private async handleFileDelete(file: TFile) {
        if (this.settings.options.enableLogging) {
            console.log(`File deleted: ${file.path}`);
        }

        // Clean up cache for deleted file
        this.fileContentCache.delete(file.path);

        // Note: Could add cleanup logic for removing metadata from other files if needed
    }

    private shouldProcessFile(file: TFile): boolean {
        // Only process markdown files
        if (file.extension !== 'md') {
            console.log(`File ${file.path} is not markdown, skipping`);
            return false;
        }

        // Check if any rules might apply to this file as a source
        const hasApplicableRules = this.settings.rules.some(rule => {
            const isEnabled = rule.enabled;
            const matchesAsSource = this.ruleEngine.matchesSourcePattern(rule, file);
            console.log(`Rule ${rule.name}: enabled=${isEnabled}, matchesAsSource=${matchesAsSource}`);
            return isEnabled && matchesAsSource;
        });
        
        console.log(`File ${file.path} has applicable rules: ${hasApplicableRules}`);
        return hasApplicableRules;
    }

    private addCommands() {
        // Process all files command
        this.addCommand({
            id: 'process-all-files',
            name: 'Process all files for backlink metadata',
            callback: async () => {
                await this.processAllFiles();
            }
        });

        // Process current file command
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

        // Validate rules command
        this.addCommand({
            id: 'validate-rules',
            name: 'Validate metadata update rules',
            callback: () => {
                this.validateRules();
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
            new Notice(`Error processing files: ${error.message}`);
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

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
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
            .setDesc('Wait time before processing file changes')
            .addText(text => text
                .setPlaceholder('1000')
                .setValue(this.plugin.settings.options.debounceMs.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value) || 1000;
                    this.plugin.settings.options.debounceMs = numValue;
                    await this.plugin.saveSettings();
                })
            );

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

        // Display existing rules
        this.plugin.settings.rules.forEach((rule, index) => {
            this.displayRule(containerEl, rule, index);
        });
    }

    private displayRule(containerEl: HTMLElement, rule: any, index: number) {
        const ruleContainer = containerEl.createDiv('rule-container');
        
        new Setting(ruleContainer)
            .setName(rule.name || `Rule ${index + 1}`)
            .setDesc(`${rule.sourcePattern} → ${rule.updateField}`)
            .addButton(button => button
                .setButtonText('Edit')
                .onClick(() => {
                    this.editRule(ruleContainer, index);
                })
            )
            .addButton(button => button
                .setButtonText('Delete')
                .setClass('mod-warning')
                .onClick(() => {
                    this.deleteRule(index);
                })
            );
    }

    private addNewRule() {
        const newRule = {
            id: `rule-${Date.now()}`,
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
        this.display(); // Refresh the display
    }

    private editRule(ruleContainer: HTMLElement, index: number) {
        const rule = this.plugin.settings.rules[index];
        
        // Check if already editing this rule
        if (ruleContainer.querySelector('.rule-editor')) {
            return;
        }
        
        // Create editor container
        const editorContainer = ruleContainer.createDiv('rule-editor');
        editorContainer.style.marginTop = '10px';
        editorContainer.style.padding = '10px';
        editorContainer.style.border = '1px solid var(--background-modifier-border)';
        editorContainer.style.borderRadius = '4px';
        
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
                const textEl = text
                    .setValue(rule.sourcePattern)
                    .onChange((value) => {
                        rule.sourcePattern = value;
                    });
                
                // Make the text field clickable like Templater
                textEl.inputEl.style.cursor = 'pointer';
                textEl.inputEl.addEventListener('click', () => {
                    const modal = new FolderSuggestModal(this.plugin.app, (folder) => {
                        const pattern = folder.path ? `${folder.path}/*` : '*';
                        rule.sourcePattern = pattern;
                        textEl.setValue(folder.path || ''); // Show folder path without /*
                    });
                    modal.open();
                });
                
                return textEl;
            });
        
        // Target Type (Tag or Folder)
        const targetTypeSetting = new Setting(editorContainer)
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
                const textComponent = text
                    .setValue(rule.targetTag || rule.targetFolder || '')
                    .onChange((value) => {
                        if (rule.targetTag !== undefined) {
                            rule.targetTag = value;
                            rule.targetFolder = undefined;
                        } else {
                            rule.targetFolder = value;
                            rule.targetTag = undefined;
                        }
                    });
                
                // Make folder field clickable like Templater when it's a folder type
                if (rule.targetFolder !== undefined) {
                    textComponent.inputEl.style.cursor = 'pointer';
                    textComponent.inputEl.addEventListener('click', () => {
                        const modal = new FolderSuggestModal(this.plugin.app, (folder) => {
                            const pattern = folder.path ? `${folder.path}/*` : '*';
                            rule.targetFolder = pattern;
                            rule.targetTag = undefined;
                            textComponent.setValue(folder.path || ''); // Show folder path without /*
                        });
                        modal.open();
                    });
                }
                
                return textComponent;
            });
        
        // Update Field
        new Setting(editorContainer)
            .setName('Update Field')
            .setDesc('Frontmatter field to update')
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
            .setDesc('Lower numbers = higher priority')
            .addText(text => text
                .setValue(rule.priority.toString())
                .onChange((value) => {
                    const numValue = parseInt(value) || 1;
                    rule.priority = numValue;
                })
            );
        
        // Enabled Toggle
        new Setting(editorContainer)
            .setName('Enabled')
            .addToggle(toggle => toggle
                .setValue(rule.enabled)
                .onChange((value) => {
                    rule.enabled = value;
                })
            );
        
        // Action buttons
        const buttonContainer = editorContainer.createDiv();
        buttonContainer.style.marginTop = '10px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '10px';
        
        const saveButton = buttonContainer.createEl('button', { text: 'Save' });
        saveButton.onclick = async () => {
            // Basic validation
            const validation = this.validateRuleInputs(rule);
            if (!validation.isValid) {
                new Notice(`Validation error: ${validation.errors.join(', ')}`);
                return;
            }
            
            // Update the rule in the settings array
            const ruleIndex = this.plugin.settings.rules.findIndex(r => r.id === rule.id);
            if (ruleIndex !== -1) {
                this.plugin.settings.rules[ruleIndex] = { ...rule };
            }
            
            await this.plugin.saveSettings();
            editorContainer.remove();
            this.display(); // Refresh to show updated rule
            new Notice('Rule saved successfully');
        };
        
        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.onclick = () => {
            editorContainer.remove();
        };
    }
    
    private updateTargetType(editorContainer: HTMLElement, rule: any, targetType: string) {
        if (targetType === 'tag') {
            rule.targetTag = rule.targetFolder || '#example';
            rule.targetFolder = undefined;
        } else {
            rule.targetFolder = rule.targetTag?.replace('#', '') || 'Example';
            rule.targetTag = undefined;
        }
        
        // Update the target value setting without removing the entire editor
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
            
            // Set up appropriate cursor and click behavior
            if (targetType === 'folder') {
                inputEl.style.cursor = 'pointer';
                // Remove any existing click handlers by cloning the element
                const newInputEl = inputEl.cloneNode(true) as HTMLInputElement;
                inputEl.replaceWith(newInputEl);
                
                // Add folder picker click handler
                newInputEl.addEventListener('click', () => {
                    const modal = new FolderSuggestModal(this.plugin.app, (folder) => {
                        const pattern = folder.path ? `${folder.path}/*` : '*';
                        rule.targetFolder = pattern;
                        rule.targetTag = undefined;
                        newInputEl.value = pattern;
                    });
                    modal.open();
                });
                
                // Add change handler for manual typing
                newInputEl.addEventListener('input', (e) => {
                    rule.targetFolder = (e.target as HTMLInputElement).value;
                    rule.targetTag = undefined;
                });
            } else {
                inputEl.style.cursor = 'text';
                // For tag input, just ensure the change handler works
                const newInputEl = inputEl.cloneNode(true) as HTMLInputElement;
                inputEl.replaceWith(newInputEl);
                
                newInputEl.addEventListener('input', (e) => {
                    rule.targetTag = (e.target as HTMLInputElement).value;
                    rule.targetFolder = undefined;
                });
            }
        }
    }
    
    private validateRuleInputs(rule: any): { isValid: boolean; errors: string[] } {
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

    private deleteRule(index: number) {
        this.plugin.settings.rules.splice(index, 1);
        this.plugin.saveSettings();
        this.display(); // Refresh the display
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