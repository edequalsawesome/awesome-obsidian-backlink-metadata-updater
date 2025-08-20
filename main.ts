import { App, TFile, Plugin, Notice, PluginSettingTab, Setting } from 'obsidian';
import { BacklinkMetadataSettings, DEFAULT_SETTINGS } from './src/types';
import { DateExtractor } from './src/utils/date-extractor';
import { RuleEngine } from './src/engine/rule-engine';
import { BacklinkProcessor } from './src/processor/backlink-processor';

export default class BacklinkMetadataPlugin extends Plugin {
    settings: BacklinkMetadataSettings;
    private dateExtractor: DateExtractor;
    private ruleEngine: RuleEngine;
    private processor: BacklinkProcessor;

    async onload() {
        await this.loadSettings();
        
        // Initialize components
        this.dateExtractor = new DateExtractor(this.app);
        this.ruleEngine = new RuleEngine(this.app);
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
        if (!this.shouldProcessFile(file)) {
            return;
        }

        if (this.settings.options.enableLogging) {
            console.log(`File modified: ${file.path}`);
        }

        // Schedule processing with debouncing
        this.processor.scheduleProcessing(file, this.settings.rules, this.settings.options);
    }

    private async handleFileRename(file: TFile, oldPath: string) {
        if (this.settings.options.enableLogging) {
            console.log(`File renamed: ${oldPath} -> ${file.path}`);
        }

        // Process the renamed file
        await this.processor.processFile(file, this.settings.rules, this.settings.options);
    }

    private async handleFileDelete(file: TFile) {
        if (this.settings.options.enableLogging) {
            console.log(`File deleted: ${file.path}`);
        }

        // Note: Cleanup logic could be added here if needed
    }

    private shouldProcessFile(file: TFile): boolean {
        // Only process markdown files
        if (file.extension !== 'md') {
            return false;
        }

        // Check if any rules might apply to this file as a source
        return this.settings.rules.some(rule => 
            rule.enabled && 
            this.ruleEngine.findApplicableRules(file, file, [rule]).length > 0
        );
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
                    this.editRule(index);
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

    private editRule(index: number) {
        // For now, just show a notice - a full rule editor would be more complex
        new Notice(`Rule editing not yet implemented. Edit rule ${index + 1} in settings file.`);
    }

    private deleteRule(index: number) {
        this.plugin.settings.rules.splice(index, 1);
        this.plugin.saveSettings();
        this.display(); // Refresh the display
    }
}