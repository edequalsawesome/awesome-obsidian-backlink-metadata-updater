import { TFile, CachedMetadata, parseFrontMatterEntry } from 'obsidian';
import { Rule, ProcessingContext, MetadataUpdate, ValueType, PluginOptions } from '../types';
import { DateExtractor } from '../utils/date-extractor';
import { RuleEngine } from '../engine/rule-engine';

export class BacklinkProcessor {
    private app: any;
    private dateExtractor: DateExtractor;
    private ruleEngine: RuleEngine;
    private processingQueue: Map<string, NodeJS.Timeout> = new Map();

    constructor(app: any, dateExtractor: DateExtractor, ruleEngine: RuleEngine) {
        this.app = app;
        this.dateExtractor = dateExtractor;
        this.ruleEngine = ruleEngine;
    }

    /**
     * Process a file with debouncing to handle rapid edits
     */
    scheduleProcessing(file: TFile, rules: Rule[], options: PluginOptions): void {
        const filePath = file.path;
        
        // Clear existing timeout for this file
        if (this.processingQueue.has(filePath)) {
            clearTimeout(this.processingQueue.get(filePath)!);
        }
        
        // Schedule new processing
        const timeout = setTimeout(async () => {
            await this.processFile(file, rules, options);
            this.processingQueue.delete(filePath);
        }, options.debounceMs);
        
        this.processingQueue.set(filePath, timeout);
    }

    /**
     * Process a file immediately (for bulk operations)
     */
    async processFile(file: TFile, rules: Rule[], options: PluginOptions): Promise<void> {
        try {
            console.log(`BacklinkProcessor: Processing file: ${file.path}`);

            // Extract outgoing links from the file
            const outgoingLinks = this.extractOutgoingLinks(file);
            
            console.log(`BacklinkProcessor: Found ${outgoingLinks.length} outgoing links:`, outgoingLinks);
            
            if (outgoingLinks.length === 0) {
                console.log(`BacklinkProcessor: No links to process in ${file.path}`);
                return; // No links to process
            }

            // Process each linked file
            for (const linkPath of outgoingLinks) {
                const targetFile = this.app.vault.getAbstractFileByPath(linkPath);
                
                if (!(targetFile instanceof TFile)) {
                    console.log(`BacklinkProcessor: Target ${linkPath} is not a valid file`);
                    continue; // Skip if not a valid file
                }

                console.log(`BacklinkProcessor: Processing link to ${targetFile.path}`);
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
        
        console.log(`BacklinkProcessor: Found ${applicableRules.length} applicable rules for ${sourceFile.path} -> ${targetFile.path}`);
        
        if (applicableRules.length === 0) {
            console.log(`BacklinkProcessor: No rules apply for ${sourceFile.path} -> ${targetFile.path}`);
            return; // No rules apply
        }

        // Process each applicable rule
        for (const rule of applicableRules) {
            console.log(`BacklinkProcessor: Applying rule ${rule.name} to ${targetFile.path}`);
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
            
            if (newValue !== undefined) {
                frontMatter[field] = newValue;
                
                // Add history tracking if enabled
                if (options.preserveHistory) {
                    this.addToHistory(frontMatter, field, value, context);
                }
            }
        });
    }

    /**
     * Merge new value with existing value based on value type
     */
    private mergeValues(currentValue: any, newValue: any, valueType: ValueType, options: PluginOptions): any {
        switch (valueType) {
            case 'date':
            case 'date_and_title':
                // Replace with new value
                return newValue;
                
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
     * Add entry to history tracking
     */
    private addToHistory(frontMatter: any, field: string, value: any, context: ProcessingContext): void {
        const historyField = `${field}History`;
        
        if (!frontMatter[historyField]) {
            frontMatter[historyField] = [];
        }
        
        const historyEntry: MetadataUpdate = {
            field,
            value,
            timestamp: new Date().toISOString(),
            sourceContext: context.sourceFile
        };
        
        frontMatter[historyField].push(historyEntry);
    }

    /**
     * Extract outgoing links from a file
     */
    private extractOutgoingLinks(file: TFile): string[] {
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
     * Process all files in the vault (for bulk operations)
     */
    async processAllFiles(rules: Rule[], options: PluginOptions, onProgress?: (current: number, total: number) => void): Promise<void> {
        const allFiles = this.app.vault.getMarkdownFiles();
        let processed = 0;
        
        for (const file of allFiles) {
            await this.processFile(file, rules, options);
            processed++;
            
            if (onProgress) {
                onProgress(processed, allFiles.length);
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