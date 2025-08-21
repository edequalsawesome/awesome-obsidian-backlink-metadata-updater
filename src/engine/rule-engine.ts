import { TFile, TAbstractFile, CachedMetadata } from 'obsidian';
import { Rule, ValidationResult, ProcessingContext } from '../types';

export class RuleEngine {
    private app: any;

    constructor(app: any) {
        this.app = app;
    }

    /**
     * Find all rules that apply to a given source/target file combination
     */
    findApplicableRules(sourceFile: TFile, targetFile: TFile, rules: Rule[]): Rule[] {
        return rules
            .filter(rule => rule.enabled)
            .filter(rule => this.matchesSourcePattern(rule, sourceFile))
            .filter(rule => this.matchesTargetCriteria(rule, targetFile))
            .sort((a, b) => a.priority - b.priority); // Higher priority first
    }

    /**
     * Check if source file matches the rule's pattern
     */
    matchesSourcePattern(rule: Rule, sourceFile: TFile): boolean {
        const pattern = rule.sourcePattern;
        
        // Handle glob-like patterns
        if (pattern.includes('*')) {
            return this.matchesGlobPattern(pattern, sourceFile.path);
        }
        
        // Exact path match
        if (pattern === sourceFile.path) {
            return true;
        }
        
        // Folder match
        if (pattern.endsWith('/') && sourceFile.path.startsWith(pattern)) {
            return true;
        }
        
        // Parent folder match
        const parentPath = sourceFile.parent?.path || '';
        if (parentPath === pattern) {
            return true;
        }
        
        return false;
    }

    /**
     * Check if target file matches the rule's target criteria
     */
    private matchesTargetCriteria(rule: Rule, targetFile: TFile): boolean {
        // Check target tag if specified
        if (rule.targetTag) {
            const hasTag = this.fileHasTag(targetFile, rule.targetTag);
            console.log(`RuleEngine: Target file ${targetFile.path} has tag ${rule.targetTag}: ${hasTag}`);
            return hasTag;
        }
        
        // Check target folder if specified
        if (rule.targetFolder) {
            const matchesFolder = this.matchesGlobPattern(rule.targetFolder, targetFile.path);
            console.log(`RuleEngine: Target file ${targetFile.path} matches folder pattern ${rule.targetFolder}: ${matchesFolder}`);
            return matchesFolder;
        }
        
        // If no specific target criteria, match all files
        console.log(`RuleEngine: No target criteria specified, matching all files for ${targetFile.path}`);
        return true;
    }

    /**
     * Check if file has a specific tag
     */
    private fileHasTag(file: TFile, tag: string): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        console.log(`RuleEngine: Cache for ${file.path}:`, cache);
        
        if (!cache) {
            console.log(`RuleEngine: No cache found for ${file.path}`);
            return false;
        }

        // Remove # from tag if present
        const cleanTag = tag.startsWith('#') ? tag.slice(1) : tag;
        console.log(`RuleEngine: Looking for tag '${cleanTag}' in ${file.path}`);
        
        // Check frontmatter tags
        if (cache.frontmatter?.tags) {
            const frontmatterTags = Array.isArray(cache.frontmatter.tags) 
                ? cache.frontmatter.tags 
                : [cache.frontmatter.tags];
            
            console.log(`RuleEngine: Frontmatter tags for ${file.path}:`, frontmatterTags);
            
            if (frontmatterTags.some((t: string) => t === cleanTag)) {
                console.log(`RuleEngine: Found matching tag '${cleanTag}' in frontmatter`);
                return true;
            }
        }
        
        // Check inline tags
        if (cache.tags) {
            console.log(`RuleEngine: Inline tags for ${file.path}:`, cache.tags);
            const hasInlineTag = cache.tags.some((tagCache: any) => 
                tagCache.tag === `#${cleanTag}` || tagCache.tag === cleanTag
            );
            if (hasInlineTag) {
                console.log(`RuleEngine: Found matching tag '${cleanTag}' in inline tags`);
                return true;
            }
        }
        
        console.log(`RuleEngine: No matching tag '${cleanTag}' found in ${file.path}`);
        return false;
    }

    /**
     * Simple glob pattern matching
     */
    private matchesGlobPattern(pattern: string, path: string): boolean {
        // Convert glob pattern to regex
        const regexPattern = pattern
            .replace(/\//g, '\\/')  // Escape forward slashes
            .replace(/\./g, '\\.')  // Escape dots
            .replace(/\*/g, '.*')   // Replace * with .*
            .replace(/\?/g, '.')    // Replace ? with .
            + '$';                  // Anchor at end
        
        const regex = new RegExp(regexPattern);
        return regex.test(path);
    }

    /**
     * Validate a rule for syntax and logical errors
     */
    validateRule(rule: Rule): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check required fields
        if (!rule.id) {
            errors.push('Rule ID is required');
        }
        
        if (!rule.name) {
            errors.push('Rule name is required');
        }
        
        if (!rule.sourcePattern) {
            errors.push('Source pattern is required');
        }
        
        if (!rule.updateField) {
            errors.push('Update field is required');
        }

        // Check that either targetTag or targetFolder is specified
        if (!rule.targetTag && !rule.targetFolder) {
            warnings.push('No target criteria specified - rule will apply to all linked files');
        }

        // Validate source pattern syntax
        if (rule.sourcePattern) {
            try {
                this.matchesGlobPattern(rule.sourcePattern, 'test/path');
            } catch (e) {
                errors.push(`Invalid source pattern: ${e.message}`);
            }
        }

        // Validate target folder pattern if specified
        if (rule.targetFolder) {
            try {
                this.matchesGlobPattern(rule.targetFolder, 'test/path');
            } catch (e) {
                errors.push(`Invalid target folder pattern: ${e.message}`);
            }
        }

        // Validate field name (should be valid YAML key)
        if (rule.updateField && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rule.updateField)) {
            errors.push('Update field must be a valid identifier (letters, numbers, underscore)');
        }

        // Validate priority
        if (rule.priority < 0) {
            errors.push('Priority must be non-negative');
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Validate a set of rules for conflicts
     */
    validateRuleSet(rules: Rule[]): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check for duplicate IDs
        const ids = rules.map(r => r.id);
        const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
        if (duplicateIds.length > 0) {
            errors.push(`Duplicate rule IDs found: ${duplicateIds.join(', ')}`);
        }

        // Check for conflicting rules (same source pattern, target criteria, and field)
        for (let i = 0; i < rules.length; i++) {
            for (let j = i + 1; j < rules.length; j++) {
                const rule1 = rules[i];
                const rule2 = rules[j];
                
                if (this.rulesConflict(rule1, rule2)) {
                    warnings.push(
                        `Rules "${rule1.name}" and "${rule2.name}" may conflict ` +
                        `(same source pattern and target criteria)`
                    );
                }
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Check if two rules conflict with each other
     */
    private rulesConflict(rule1: Rule, rule2: Rule): boolean {
        // Same source pattern
        if (rule1.sourcePattern !== rule2.sourcePattern) {
            return false;
        }
        
        // Same target criteria
        if (rule1.targetTag !== rule2.targetTag || rule1.targetFolder !== rule2.targetFolder) {
            return false;
        }
        
        // Same update field
        if (rule1.updateField !== rule2.updateField) {
            return false;
        }
        
        return true;
    }

    /**
     * Get all files that match a source pattern
     */
    getFilesMatchingPattern(pattern: string): TFile[] {
        return this.app.vault.getMarkdownFiles()
            .filter((file: TFile) => this.matchesGlobPattern(pattern, file.path));
    }

    /**
     * Get all files that have a specific tag
     */
    getFilesWithTag(tag: string): TFile[] {
        const cleanTag = tag.startsWith('#') ? tag.slice(1) : tag;
        
        return this.app.vault.getMarkdownFiles()
            .filter((file: TFile) => this.fileHasTag(file, cleanTag));
    }

    /**
     * Get all files in a folder pattern
     */
    getFilesInFolder(folderPattern: string): TFile[] {
        return this.app.vault.getMarkdownFiles()
            .filter((file: TFile) => this.matchesGlobPattern(folderPattern, file.path));
    }
}