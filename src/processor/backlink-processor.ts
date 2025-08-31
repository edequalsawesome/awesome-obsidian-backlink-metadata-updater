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
                console.log(`BacklinkProcessor: No valid value generated for rule ${rule.name} (${rule.valueType}), skipping update`);
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
            
            console.log(`BacklinkProcessor: Processing field ${field}, currentValue:`, currentValue, 'newValue:', newValue);
            
            // Add history tracking if enabled (before updating the field)
            // Check rule-specific setting first, fall back to global setting
            const shouldPreserveHistory = context.rule.preserveHistory !== undefined 
                ? context.rule.preserveHistory 
                : options.preserveHistory;
                
            if (shouldPreserveHistory && value !== null && value !== undefined) {
                console.log(`BacklinkProcessor: Adding to history for field ${field}, preserveHistory: ${shouldPreserveHistory} (rule: ${context.rule.preserveHistory}, global: ${options.preserveHistory})`);
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
            case 'date':
            case 'date_and_title':
                // For date fields, only update if the new date is more recent
                if (currentValue && newValue) {
                    const currentDate = new Date(currentValue);
                    const newDate = new Date(newValue);
                    
                    // Check if dates are valid before calling toISOString()
                    const currentValid = !isNaN(currentDate.getTime());
                    const newValid = !isNaN(newDate.getTime());
                    
                    if (currentValid && newValid) {
                        console.log(`BacklinkProcessor: Date comparison - current: ${currentValue} (${currentDate.toISOString()}), new: ${newValue} (${newDate.toISOString()})`);
                    } else {
                        console.log(`BacklinkProcessor: Date comparison - current: ${currentValue} (valid: ${currentValid}), new: ${newValue} (valid: ${newValid})`);
                    }
                    
                    // Only update if new date is more recent (or if dates are invalid, use new value)
                    if (!currentValid || !newValid || newDate > currentDate) {
                        if (newValid) {
                            console.log(`BacklinkProcessor: Using new date ${newValue} (more recent or current invalid)`);
                            return newValue;
                        } else if (currentValid) {
                            console.log(`BacklinkProcessor: Keeping existing date ${currentValue} (new date invalid)`);
                            return currentValue;
                        } else {
                            console.log(`BacklinkProcessor: Both dates invalid, skipping update`);
                            return currentValue; // Keep current if both invalid
                        }
                    } else {
                        console.log(`BacklinkProcessor: Keeping existing date ${currentValue} (more recent than ${newValue})`);
                        // Keep the existing more recent date
                        return currentValue;
                    }
                }
                // If no current value or new value is missing, use new value only if valid
                if (newValue) {
                    const testDate = new Date(newValue);
                    if (!isNaN(testDate.getTime())) {
                        return newValue;
                    }
                }
                return currentValue; // Keep existing if new value is invalid
                
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
        // Use custom history field names for specific fields
        let historyField: string;
        if (field === 'lastWatched') {
            historyField = 'watchHistory';
        } else if (field === 'lastRead') {
            historyField = 'readHistory';
        } else {
            historyField = `${field}History`;
        }
        
        console.log(`BacklinkProcessor: addToHistory called for field ${field}, historyField: ${historyField}`);
        
        if (!frontMatter[historyField]) {
            frontMatter[historyField] = [];
            console.log(`BacklinkProcessor: Created new history array for ${historyField}`);
        }
        
        // For date fields, just store the date value (YYYY-MM-DD)
        // For other fields, store the full metadata
        let historyEntry: any;
        if (field === 'lastWatched' || field === 'lastRead') {
            historyEntry = value; // Just store the date string
        } else {
            historyEntry = {
                field,
                value,
                timestamp: new Date().toISOString(),
                sourceContext: context.sourceFile
            };
        }
        
        console.log(`BacklinkProcessor: Adding history entry:`, historyEntry);
        
        // Avoid duplicates for date fields
        if (field === 'lastWatched' || field === 'lastRead') {
            if (!frontMatter[historyField].includes(value)) {
                frontMatter[historyField].push(historyEntry);
            }
        } else {
            frontMatter[historyField].push(historyEntry);
        }
        
        console.log(`BacklinkProcessor: History array now has ${frontMatter[historyField].length} entries`);
    }

    /**
     * Extract outgoing links from a file
     */
    private extractOutgoingLinks(file: TFile): string[] {
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
                const linkPattern = /\[\[([^\]]+)\]\]/g;
                
                // Check common fields that might contain links
                const fieldsToCheck = ['attendees', 'attendee', 'participants', 'participant', 
                                       'people', 'person', 'with', 'employee', 'employees',
                                       'team', 'members', 'related', 'links', 'notes'];
                
                for (const field of fieldsToCheck) {
                    const value = frontmatter[field];
                    if (value) {
                        // Handle both string and array values
                        const values = Array.isArray(value) ? value : [value];
                        
                        for (const val of values) {
                            if (typeof val === 'string') {
                                // Extract wikilinks from the string
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