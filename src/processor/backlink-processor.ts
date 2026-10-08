import { App, TFile, moment, getLinkpath } from 'obsidian';
import { Rule, ProcessingContext, ValueType, PluginOptions } from '../types';
import { DateExtractor } from '../utils/date-extractor';
import { RuleEngine } from '../engine/rule-engine';

const MAX_HISTORY_ENTRIES = 100;

export class BacklinkProcessor {
    private app: App;
    private dateExtractor: DateExtractor;
    private ruleEngine: RuleEngine;
    private processingQueue: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private stopped = false;
    private sourceOperations = new Map<string, Promise<unknown>>();

    constructor(app: App, dateExtractor: DateExtractor, ruleEngine: RuleEngine) {
        this.app = app;
        this.dateExtractor = dateExtractor;
        this.ruleEngine = ruleEngine;
    }

    /**
     * Process a file with debouncing to handle rapid edits.
     * Captures file path (not TFile reference) to avoid stale references.
     */
    scheduleProcessing(file: TFile, rules: Rule[], options: PluginOptions, onError?: (error: unknown) => void): void {
        if (this.stopped || file.extension !== 'md') return;
        const filePath = file.path;

        // Clear existing timeout for this file
        if (this.processingQueue.has(filePath)) {
            clearTimeout(this.processingQueue.get(filePath)!);
        }

        // Schedule new processing — re-resolve file by path at execution time
        const timeout = setTimeout(async () => {
            if (this.processingQueue.get(filePath) !== timeout) return;
            this.processingQueue.delete(filePath);
            const currentFile = this.app.vault.getAbstractFileByPath(filePath);
            if (currentFile instanceof TFile) {
                try {
                    await this.processFile(currentFile, rules, options);
                } catch (error) {
                    console.error(`Error processing file ${filePath}:`, error);
                    onError?.(error);
                }
            }
        }, options.debounceMs);

        this.processingQueue.set(filePath, timeout);
    }

    /**
     * Process a file immediately (for bulk operations)
     */
    async processFile(file: TFile, rules: Rule[], options: PluginOptions): Promise<void> {
        const sourcePath = file.path;
        return this.runForSource(sourcePath, () => this.processFileNow(file, rules, options, sourcePath));
    }

    private runForSource<T>(path: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.sourceOperations.get(path) || Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.sourceOperations.set(path, next);
        const clear = () => {
            if (this.sourceOperations.get(path) === next) this.sourceOperations.delete(path);
        };
        void next.then(clear, clear);
        return next;
    }

    private async processFileNow(file: TFile, rules: Rule[], options: PluginOptions, sourcePath: string): Promise<void> {
        if (this.stopped || file.extension !== 'md') return;
        if (file.path !== sourcePath || this.app.vault.getAbstractFileByPath(sourcePath) !== file) return;
        try {
            if (options.enableLogging) {
                console.log(`BacklinkProcessor: Processing file: ${file.path}`);
            }

            // Extract outgoing links from the file
            const outgoingLinks = this.extractOutgoingLinks(file, rules);

            if (options.enableLogging) {
                console.log(`BacklinkProcessor: Found ${outgoingLinks.length} outgoing links`);
            }

            if (outgoingLinks.length === 0) {
                return; // No links to process
            }

            // Process each linked file
            for (const linkPath of outgoingLinks) {
                if (this.stopped) return;
                if (file.path !== sourcePath || this.app.vault.getAbstractFileByPath(sourcePath) !== file) return;
                const targetFile = this.app.vault.getAbstractFileByPath(linkPath);

                if (!(targetFile instanceof TFile) || targetFile.extension !== 'md') {
                    continue; // Skip if not a valid file
                }

                await this.processFileLink(file, targetFile, rules, options);
            }
        } catch (error) {
            console.error(`Error processing file ${file.path}:`, error);
            throw error;
        }
    }

    /**
     * Process a single link between source and target file
     */
    private async processFileLink(
        sourceFile: TFile,
        targetFile: TFile,
        rules: Rule[],
        options: PluginOptions
    ): Promise<void> {
        // Find applicable rules for this file combination
        const applicableRules = this.ruleEngine.findApplicableRules(sourceFile, targetFile, rules);

        if (options.enableLogging) {
            console.log(`BacklinkProcessor: Found ${applicableRules.length} applicable rules for ${sourceFile.path} -> ${targetFile.path}`);
        }

        if (applicableRules.length === 0) {
            return; // No rules apply
        }

        // Process each applicable rule
        const sourcePath = sourceFile.path;
        for (const rule of applicableRules) {
            if (this.stopped) return;
            if (sourceFile.path !== sourcePath || this.app.vault.getAbstractFileByPath(sourcePath) !== sourceFile) return;
            if (options.enableLogging) {
                console.log(`BacklinkProcessor: Applying rule ${rule.name} to ${targetFile.path}`);
            }
            await this.applyRule(sourceFile, targetFile, rule, options, rules.map(rule => rule.updateField));
        }
    }

    /**
     * Apply a specific rule to update target file metadata
     */
    private async applyRule(
        sourceFile: TFile,
        targetFile: TFile,
        rule: Rule,
        options: PluginOptions,
        generatedFields: string[]
    ): Promise<void> {
        try {
            // Create processing context
            const context: ProcessingContext = {
                sourceFile: sourceFile.path,
                targetFile: targetFile.path,
                extractedDate: rule.valueType === 'date' || rule.valueType === 'date_and_title'
                    ? this.dateExtractor.extractDate(sourceFile, generatedFields) || undefined : undefined,
                extractedTitle: rule.valueType === 'date_and_title'
                    ? this.dateExtractor.extractTitle(sourceFile, generatedFields) || undefined : undefined,
                rule
            };

            // Generate the value to update
            const updateValue = this.generateUpdateValue(context, options);
            if (updateValue === null || updateValue === undefined) {
                if (options.enableLogging) {
                    console.log(`BacklinkProcessor: No valid value generated for rule ${rule.name} (${rule.valueType}), skipping update`);
                }
                return; // No valid value to update
            }

            // Apply the update to the target file
            await this.updateTargetFileMetadata(targetFile, rule.updateField, updateValue, context, options);

        } catch (error) {
            console.error(`Error applying rule ${rule.id}:`, error);
            throw error;
        }
    }

    /**
     * Generate the value to update based on the rule's value type
     */
    private generateUpdateValue(context: ProcessingContext, options: PluginOptions): any {
        switch (context.rule.valueType) {
            case 'date':
                return context.extractedDate;

            case 'date_and_title':
                if (context.extractedDate && context.extractedTitle) {
                    return {
                        date: context.extractedDate,
                        title: context.extractedTitle,
                        source: `[[${context.sourceFile}]]`
                    };
                }
                return context.extractedDate;

            case 'append_link':
                return `[[${context.sourceFile}]]`;

            case 'append_unique_link':
                return `[[${context.sourceFile}]]`;

            case 'replace_link':
                return `[[${context.sourceFile}]]`;

            default:
                return null;
        }
    }

    /**
     * Update the target file's metadata
     */
    private async updateTargetFileMetadata(
        targetFile: TFile,
        field: string,
        value: any,
        context: ProcessingContext,
        options: PluginOptions
    ): Promise<void> {
        if (this.stopped) return;
        if (['__proto__', 'constructor', 'prototype'].includes(field)) {
            throw new Error('Reserved metadata field name');
        }
        await this.app.fileManager.processFrontMatter(targetFile, (frontMatter: any) => {
            const currentValue = Object.prototype.hasOwnProperty.call(frontMatter, field) ? frontMatter[field] : undefined;
            const newValue = this.mergeValues(currentValue, value, context.rule.valueType, options);

            if (options.enableLogging) {
                console.log(`BacklinkProcessor: Processing field ${field}, currentValue:`, currentValue, 'newValue:', newValue);
            }

            // Add history tracking if enabled (before updating the field)
            const shouldPreserveHistory = context.rule.preserveHistory !== undefined
                ? context.rule.preserveHistory
                : options.preserveHistory;

            if (shouldPreserveHistory && value !== null && value !== undefined) {
                this.addToHistory(frontMatter, field, value, context);
            }

            if (newValue !== undefined) {
                frontMatter[field] = newValue;
            }
        });
    }

    /**
     * Merge new value with existing value based on value type
     */
    private mergeValues(currentValue: any, newValue: any, valueType: ValueType, options: PluginOptions): any {
        switch (valueType) {
            case 'date': {
                // Extract date strings for comparison
                const currentDateStr = typeof currentValue === 'string' ? currentValue : null;
                const newDateStr = typeof newValue === 'string' ? newValue : null;

                if (currentDateStr && newDateStr) {
                    const currentDate = this.parseStoredDate(currentDateStr, options.dateFormat);
                    const newDate = moment(newDateStr, options.dateFormat, true);
                    const currentValid = currentDate.isValid();
                    const newValid = newDate.isValid();

                    if (!currentValid) return currentValue;
                    if (!newValid || newDate > currentDate) {
                        return newValid ? newDateStr : currentDateStr;
                    }
                    return currentDateStr;
                }
                if (newDateStr) {
                    if (moment(newDateStr, options.dateFormat, true).isValid()) return newDateStr;
                }
                return currentValue;
            }

            case 'date_and_title': {
                // Extract date from objects or strings for comparison
                const currentDateVal = typeof currentValue === 'object' && currentValue?.date
                    ? currentValue.date
                    : (typeof currentValue === 'string' ? currentValue : null);
                const newDateVal = typeof newValue === 'object' && newValue?.date
                    ? newValue.date
                    : (typeof newValue === 'string' ? newValue : null);

                if (currentDateVal && newDateVal) {
                    const currentDate = this.parseStoredDate(currentDateVal, options.dateFormat);
                    const newDate = moment(newDateVal, options.dateFormat, true);
                    const currentValid = currentDate.isValid();
                    const newValid = newDate.isValid();

                    if (!currentValid) return currentValue;
                    if (newValid && newDate.valueOf() === currentDate.valueOf()
                        && currentValue?.source && currentValue.source === newValue?.source) return newValue;
                    if (!newValid || newDate > currentDate) {
                        return newValid ? newValue : currentValue;
                    }
                    return currentValue;
                }
                if (newDateVal) {
                    if (moment(newDateVal, options.dateFormat, true).isValid()) return newValue;
                }
                return currentValue;
            }

            case 'append_link':
                if (currentValue === undefined) {
                    return [newValue];
                } else if (Array.isArray(currentValue)) {
                    return [...currentValue, newValue];
                } else {
                    return [currentValue, newValue];
                }

            case 'append_unique_link':
                if (currentValue === undefined) {
                    return [newValue];
                } else if (Array.isArray(currentValue)) {
                    return currentValue.includes(newValue) ? currentValue : [...currentValue, newValue];
                } else {
                    return currentValue === newValue ? [currentValue] : [currentValue, newValue];
                }

            case 'replace_link':
                return newValue;

            default:
                return newValue;
        }
    }

    private parseStoredDate(value: string, format: string): moment.Moment {
        const configured = moment(value, format, true);
        return configured.isValid() ? configured : moment(value, moment.ISO_8601, true);
    }

    /**
     * Add entry to history tracking (capped at MAX_HISTORY_ENTRIES)
     */
    private addToHistory(frontMatter: any, field: string, value: any, context: ProcessingContext): void {
        // Use custom history field names for specific fields
        const historyField = this.getHistoryField(field);

        if (!Array.isArray(frontMatter[historyField])) {
            const existing = Object.prototype.hasOwnProperty.call(frontMatter, historyField) ? frontMatter[historyField] : undefined;
            frontMatter[historyField] = existing == null ? [] : [existing];
        }

        // For date fields, just store the date value (YYYY-MM-DD)
        let historyEntry: any;
        if (field === 'lastWatched' || field === 'lastRead') {
            historyEntry = value;
        } else {
            historyEntry = {
                field,
                value,
                timestamp: new Date().toISOString(),
                sourceContext: context.sourceFile
            };
        }

        // Avoid duplicates for date fields
        if (field === 'lastWatched' || field === 'lastRead') {
            if (!frontMatter[historyField].includes(value)) {
                frontMatter[historyField].push(historyEntry);
            }
        } else {
            const duplicate = frontMatter[historyField].some((entry: any) =>
                entry?.sourceContext === context.sourceFile && JSON.stringify(entry.value) === JSON.stringify(value));
            if (!duplicate) frontMatter[historyField].push(historyEntry);
        }

        // Cap history array size
        if (frontMatter[historyField].length > MAX_HISTORY_ENTRIES) {
            frontMatter[historyField] = frontMatter[historyField].slice(-MAX_HISTORY_ENTRIES);
        }
    }

    /**
     * Extract outgoing links from a file (body content + frontmatter)
     */
    private getHistoryField(field: string): string {
        return field === 'lastWatched' ? 'watchHistory' : field === 'lastRead' ? 'readHistory' : `${field}History`;
    }

    extractOutgoingLinks(file: TFile, rules: Rule[] = []): string[] {
        const cache = this.app.metadataCache.getFileCache(file);
        const links: string[] = [];
        const generatedFields = new Set<string>();
        for (const rule of rules) {
            generatedFields.add(rule.updateField);
            generatedFields.add(this.getHistoryField(rule.updateField));
        }

        // Extract links from body content
        if (cache?.links) {
            for (const link of cache.links) {
                const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link.link), file.path);
                if (resolvedFile && resolvedFile instanceof TFile) {
                    links.push(resolvedFile.path);
                }
            }
        }

        // Extract links from frontmatter
        if (cache?.frontmatter) {
            // Check frontmatterLinks if available (Obsidian 1.4+)
            if (cache.frontmatterLinks) {
                for (const link of cache.frontmatterLinks) {
                    if (generatedFields.has(link.key.split('.')[0])) continue;
                    const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link.link), file.path);
                    if (resolvedFile && resolvedFile instanceof TFile) {
                        links.push(resolvedFile.path);
                    }
                }
            } else {
                // Fallback: manually parse common frontmatter fields that might contain links
                const frontmatter = cache.frontmatter;

                // Check common fields that might contain links
                const fieldsToCheck = ['attendees', 'attendee', 'participants', 'participant',
                                       'people', 'person', 'with', 'employee', 'employees',
                                       'team', 'members', 'related', 'links', 'notes'];

                for (const field of fieldsToCheck) {
                    if (generatedFields.has(field)) continue;
                    const value = frontmatter[field];
                    if (value) {
                        const values = Array.isArray(value) ? value : [value];

                        for (const val of values) {
                            if (typeof val === 'string') {
                                // Declare regex inside loop to avoid lastIndex state leak
                                const linkPattern = /\[\[([^\]]+)\]\]/g;
                                let match;
                                while ((match = linkPattern.exec(val)) !== null) {
                                    const linkPath = getLinkpath(match[1].split('|')[0]);
                                    const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
                                    if (resolvedFile && resolvedFile instanceof TFile) {
                                        links.push(resolvedFile.path);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        return [...new Set(links)]; // Remove duplicates
    }

    /**
     * Get all files that link to a target file
     */
    getIncomingLinks(targetFile: TFile): TFile[] {
        const resolvedLinks = this.app.metadataCache.resolvedLinks;
        const incomingFiles: TFile[] = [];

        for (const sourcePath in resolvedLinks) {
            const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) continue;

            const links = resolvedLinks[sourcePath];
            if (links[targetFile.path]) {
                incomingFiles.push(sourceFile);
            }
        }

        return incomingFiles;
    }

    /**
     * Process all files in the vault (for bulk operations).
     * Yields to UI every batch to prevent freezing.
     */
    async processAllFiles(rules: Rule[], options: PluginOptions, onProgress?: (current: number, total: number) => void): Promise<void> {
        const allFiles = this.app.vault.getMarkdownFiles();
        let processed = 0;
        const BATCH_SIZE = 20;

        for (const file of allFiles) {
            if (this.stopped) return;
            await this.processFile(file, rules, options);
            processed++;

            if (onProgress) {
                onProgress(processed, allFiles.length);
            }

            // Yield to UI every batch so it can repaint
            if (processed % BATCH_SIZE === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }

    /**
     * Clean up metadata when links are removed
     */
    async cleanupRemovedLinks(sourceFile: TFile, removedLinks: string[], rules: Rule[], options: PluginOptions, sourcePath = sourceFile.path): Promise<boolean> {
        if (!options.updateOnDelete) return false;
        if (removedLinks.length === 0) return true;
        return this.runForSource(sourcePath, () => this.cleanupRemovedLinksNow(sourceFile, removedLinks, rules, options, sourcePath));
    }

    private async cleanupRemovedLinksNow(sourceFile: TFile, removedLinks: string[], rules: Rule[], options: PluginOptions, sourcePath: string): Promise<boolean> {
        if (!options.updateOnDelete) return false;

        for (const linkPath of removedLinks) {
            if (this.stopped || !options.updateOnDelete) return false;
            const targetFile = this.app.vault.getAbstractFileByPath(linkPath);
            if (!(targetFile instanceof TFile) || targetFile.extension !== 'md') continue;

            const applicableRules = this.ruleEngine.findApplicableRules({ ...sourceFile, path: sourcePath } as TFile, targetFile, rules);

            for (const rule of applicableRules) {
                if (this.stopped || !options.updateOnDelete) return false;
                const current = this.app.vault.getAbstractFileByPath(sourcePath);
                if (current instanceof TFile && current.extension === 'md'
                    && this.extractOutgoingLinks(current, rules).includes(linkPath)) break;
                await this.removeFromMetadata(targetFile, rule.updateField, sourcePath, rule.valueType);
            }
        }
        return true;
    }

    /**
     * Remove specific values from metadata
     */
    private async removeFromMetadata(
        targetFile: TFile,
        field: string,
        sourceFilePath: string,
        valueType: ValueType
    ): Promise<void> {
        await this.app.fileManager.processFrontMatter(targetFile, (frontMatter: any) => {
            const currentValue = frontMatter[field];
            if (currentValue === undefined) return;

            const linkToRemove = `[[${sourceFilePath}]]`;

            if (Array.isArray(currentValue)) {
                frontMatter[field] = currentValue.filter((item: any) => {
                    if (typeof item === 'string') {
                        return item !== linkToRemove;
                    } else if (item && typeof item === 'object' && item.source) {
                        return item.source !== linkToRemove;
                    }
                    return true;
                });

                // Clean up empty arrays
                if (frontMatter[field].length === 0) {
                    delete frontMatter[field];
                }
            } else if (currentValue === linkToRemove || (valueType === 'date_and_title' && currentValue?.source === linkToRemove)) {
                delete frontMatter[field];
            }
        });
    }

    /**
     * Cancel all pending processing
     */
    cancelAllProcessing(): void {
        this.stopped = true;
        for (const timeout of this.processingQueue.values()) {
            clearTimeout(timeout);
        }
        this.processingQueue.clear();
    }
}
