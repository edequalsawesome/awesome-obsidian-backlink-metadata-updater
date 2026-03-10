import { App, TFile, CachedMetadata, parseFrontMatterEntry } from 'obsidian';
import { Rule, ProcessingContext, MetadataUpdate, ValueType, PluginOptions } from '../types';
import { DateExtractor } from '../utils/date-extractor';
import { RuleEngine } from '../engine/rule-engine';

const MAX_HISTORY_ENTRIES = 100;

export class BacklinkProcessor {
    private app: App;
    private dateExtractor: DateExtractor;
    private ruleEngine: RuleEngine;
    private processingQueue: Map<string, ReturnType<typeof setTimeout>> = new Map();

    constructor(app: App, dateExtractor: DateExtractor, ruleEngine: RuleEngine) {
        this.app = app;
        this.dateExtractor = dateExtractor;
        this.ruleEngine = ruleEngine;
    }

    /**
     * Process a file with debouncing to handle rapid edits.
     * Captures file path (not TFile reference) to avoid stale references.
     */
    scheduleProcessing(file: TFile, rules: Rule[], options: PluginOptions): void {
        const filePath = file.path;

        // Clear existing timeout for this file
        if (this.processingQueue.has(filePath)) {
            clearTimeout(this.processingQueue.get(filePath)!);
        }

        // Schedule new processing — re-resolve file by path at execution time
        const timeout = setTimeout(async () => {
            const currentFile = this.app.vault.getAbstractFileByPath(filePath);
            if (currentFile instanceof TFile) {
                await this.processFile(currentFile, rules, options);
            }
            this.processingQueue.delete(filePath);
        }, options.debounceMs);

        this.processingQueue.set(filePath, timeout);
    }

    /**
     * Process a file immediately (for bulk operations)
     */
    async processFile(file: TFile, rules: Rule[], options: PluginOptions): Promise<void> {
        try {
            if (options.enableLogging) {
                console.log(`BacklinkProcessor: Processing file: ${file.path}`);
            }

            // Extract outgoing links from the file
            const outgoingLinks = this.extractOutgoingLinks(file);

            if (options.enableLogging) {
                console.log(`BacklinkProcessor: Found ${outgoingLinks.length} outgoing links`);
            }

            if (outgoingLinks.length === 0) {
                return; // No links to process
            }

            // Process each linked file
            for (const linkPath of outgoingLinks) {
                const targetFile = this.app.vault.getAbstractFileByPath(linkPath);

                if (!(targetFile instanceof TFile)) {
                    continue; // Skip if not a valid file
                }

                await this.processFileLink(file, targetFile, rules, options);
            }
        } catch (error) {
            console.error(`Error processing file ${file.path}:`, error);
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
        for (const rule of applicableRules) {
            if (options.enableLogging) {
                console.log(`BacklinkProcessor: Applying rule ${rule.name} to ${targetFile.path}`);
            }
            await this.applyRule(sourceFile, targetFile, rule, options);
        }
    }

    /**
     * Apply a specific rule to update target file metadata
     */
    private async applyRule(
        sourceFile: TFile,
        targetFile: TFile,
        rule: Rule,
        options: PluginOptions
    ): Promise<void> {
        try {
            // Create processing context
            const context: ProcessingContext = {
                sourceFile: sourceFile.path,
                targetFile: targetFile.path,
                extractedDate: this.dateExtractor.extractDate(sourceFile) || undefined,
                extractedTitle: this.dateExtractor.extractTitle(sourceFile) || undefined,
                rule
            };

            // Generate the value to update
            const updateValue = this.generateUpdateValue(context, options);
            if (updateValue === null) {
                if (options.enableLogging) {
                    console.log(`BacklinkProcessor: No valid value generated for rule ${rule.name} (${rule.valueType}), skipping update`);
                }
                return; // No valid value to update
            }

            // Apply the update to the target file
            await this.updateTargetFileMetadata(targetFile, rule.updateField, updateValue, context, options);

        } catch (error) {
            console.error(`Error applying rule ${rule.id}:`, error);
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
        await this.app.fileManager.processFrontMatter(targetFile, (frontMatter: any) => {
            const currentValue = frontMatter[field];
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
                    const currentDate = new Date(currentDateStr);
                    const newDate = new Date(newDateStr);
                    const currentValid = !isNaN(currentDate.getTime());
                    const newValid = !isNaN(newDate.getTime());

                    if (!currentValid || !newValid || newDate > currentDate) {
                        return newValid ? newDateStr : currentDateStr;
                    }
                    return currentDateStr;
                }
                if (newDateStr) {
                    const testDate = new Date(newDateStr);
                    if (!isNaN(testDate.getTime())) return newDateStr;
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
                    const currentDate = new Date(currentDateVal);
                    const newDate = new Date(newDateVal);
                    const currentValid = !isNaN(currentDate.getTime());
                    const newValid = !isNaN(newDate.getTime());

                    if (!currentValid || !newValid || newDate > currentDate) {
                        return newValid ? newValue : currentValue;
                    }
                    return currentValue;
                }
                if (newDateVal) {
                    const testDate = new Date(newDateVal);
                    if (!isNaN(testDate.getTime())) return newValue;
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

    /**
     * Add entry to history tracking (capped at MAX_HISTORY_ENTRIES)
     */
    private addToHistory(frontMatter: any, field: string, value: any, context: ProcessingContext): void {
        // Use custom history field names for specific fields
        let historyField: string;
        if (field === 'lastWatched') {
            historyField = 'watchHistory';
        } else if (field === 'lastRead') {
            historyField = 'readHistory';
        } else {
            historyField = `${field}History`;
        }

        if (!frontMatter[historyField]) {
            frontMatter[historyField] = [];
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
            frontMatter[historyField].push(historyEntry);
        }

        // Cap history array size
        if (frontMatter[historyField].length > MAX_HISTORY_ENTRIES) {
            frontMatter[historyField] = frontMatter[historyField].slice(-MAX_HISTORY_ENTRIES);
        }
    }

    /**
     * Extract outgoing links from a file (body content + frontmatter)
     */
    extractOutgoingLinks(file: TFile): string[] {
        const cache = this.app.metadataCache.getFileCache(file);
        const links: string[] = [];

        // Extract links from body content
        if (cache?.links) {
            for (const link of cache.links) {
                const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
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
                    const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
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
                    const value = frontmatter[field];
                    if (value) {
                        const values = Array.isArray(value) ? value : [value];

                        for (const val of values) {
                            if (typeof val === 'string') {
                                // Declare regex inside loop to avoid lastIndex state leak
                                const linkPattern = /\[\[([^\]]+)\]\]/g;
                                let match;
                                while ((match = linkPattern.exec(val)) !== null) {
                                    const linkPath = match[1].split('|')[0]; // Handle aliased links
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
    async cleanupRemovedLinks(sourceFile: TFile, removedLinks: string[], rules: Rule[], options: PluginOptions): Promise<void> {
        if (!options.updateOnDelete) {
            return;
        }

        for (const linkPath of removedLinks) {
            const targetFile = this.app.vault.getAbstractFileByPath(linkPath);
            if (!(targetFile instanceof TFile)) continue;

            const applicableRules = this.ruleEngine.findApplicableRules(sourceFile, targetFile, rules);

            for (const rule of applicableRules) {
                await this.removeFromMetadata(targetFile, rule.updateField, sourceFile.path, rule.valueType);
            }
        }
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
                    } else if (typeof item === 'object' && item.source) {
                        return item.source !== linkToRemove;
                    }
                    return true;
                });

                // Clean up empty arrays
                if (frontMatter[field].length === 0) {
                    delete frontMatter[field];
                }
            } else if (currentValue === linkToRemove) {
                delete frontMatter[field];
            }
        });
    }

    /**
     * Cancel all pending processing
     */
    cancelAllProcessing(): void {
        for (const timeout of this.processingQueue.values()) {
            clearTimeout(timeout);
        }
        this.processingQueue.clear();
    }
}
