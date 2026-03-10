import { App, TFile, TAbstractFile, CachedMetadata } from 'obsidian';
import { Rule, ValidationResult, ProcessingContext } from '../types';

export class RuleEngine {
    private app: App;
    private regexCache: Map<string, RegExp> = new Map();
    private enableLogging: boolean = false;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Set logging state from plugin options.
     */
    setLogging(enabled: boolean): void {
        this.enableLogging = enabled;
    }

    /**
     * Find all rules that apply to a given source/target file combination
     */
    findApplicableRules(sourceFile: TFile, targetFile: TFile, rules: Rule[]): Rule[] {
        return rules
            .filter(rule => rule.enabled)
            .filter(rule => this.matchesSourcePattern(rule, sourceFile))
            .filter(rule => this.matchesTargetCriteria(rule, targetFile))
            .sort((a, b) => a.priority - b.priority); // Lower priority number = higher priority, processed first
    }

    /**
     * Check if source file matches the rule's pattern
     */
    matchesSourcePattern(rule: Rule, sourceFile: TFile): boolean {
        let pattern = rule.sourcePattern;

        // Handle glob-like patterns
        if (pattern.includes('*')) {
            // Source patterns ending with /* should match recursively (/**)
            // since the folder picker appends /* but users expect recursive matching
            if (pattern.endsWith('/*') && !pattern.endsWith('/**')) {
                pattern = pattern.slice(0, -2) + '/**';
            }
            return this.matchesGlobPattern(pattern, sourceFile.path);
        }

        // Exact path match
        if (pattern === sourceFile.path) {
            return true;
        }

        // Folder match (with or without trailing slash) — recursive
        if (sourceFile.path.startsWith(pattern.endsWith('/') ? pattern : pattern + '/')) {
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
            if (this.enableLogging) {
                console.log(`RuleEngine: Target file ${targetFile.path} has tag ${rule.targetTag}: ${hasTag}`);
            }
            return hasTag;
        }

        // Check target folder if specified
        if (rule.targetFolder) {
            // Target folder semantically means "any file under this folder tree"
            // Bare folder names (no glob) get /** appended; /* gets promoted to /**
            let folderPattern = rule.targetFolder;
            if (!folderPattern.includes('*')) {
                // Bare folder name like "Places" → "Places/**"
                folderPattern = folderPattern.replace(/\/+$/, '') + '/**';
            } else if (folderPattern.endsWith('/*') && !folderPattern.endsWith('/**')) {
                folderPattern = folderPattern.slice(0, -2) + '/**';
            }
            const matchesFolder = this.matchesGlobPattern(folderPattern, targetFile.path);
            if (this.enableLogging) {
                console.log(`RuleEngine: Target file ${targetFile.path} matches folder pattern ${rule.targetFolder} (resolved: ${folderPattern}): ${matchesFolder}`);
            }
            return matchesFolder;
        }

        // If no specific target criteria, match all files
        if (this.enableLogging) {
            console.log(`RuleEngine: No target criteria specified, matching all files for ${targetFile.path}`);
        }
        return true;
    }

    /**
     * Check if file has a specific tag
     */
    private fileHasTag(file: TFile, tag: string): boolean {
        const cache = this.app.metadataCache.getFileCache(file);

        if (!cache) {
            return false;
        }

        // Remove # from tag if present
        const cleanTag = tag.startsWith('#') ? tag.slice(1) : tag;

        // Check frontmatter tags
        if (cache.frontmatter?.tags) {
            const frontmatterTags = Array.isArray(cache.frontmatter.tags)
                ? cache.frontmatter.tags
                : [cache.frontmatter.tags];

            if (frontmatterTags.some((t: string) => t === cleanTag)) {
                return true;
            }
        }

        // Check inline tags
        if (cache.tags) {
            const hasInlineTag = cache.tags.some((tagCache: any) =>
                tagCache.tag === `#${cleanTag}` || tagCache.tag === cleanTag
            );
            if (hasInlineTag) {
                return true;
            }
        }

        return false;
    }

    /**
     * Glob pattern matching with regex caching.
     * Single * matches within a path segment (no /), ** matches across segments.
     */
    private matchesGlobPattern(pattern: string, path: string): boolean {
        let regex = this.regexCache.get(pattern);
        if (!regex) {
            const regexPattern = '^' + pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars (except * and ?)
                .replace(/\//g, '\\/')                    // Escape forward slashes
                .replace(/\*\*/g, '##GLOBSTAR##')         // Temporarily replace **
                .replace(/\*/g, '[^/]*')                  // Single * = within one path segment
                .replace(/##GLOBSTAR##/g, '.*')           // ** = across path segments
                .replace(/\?/g, '[^/]')                   // ? = single non-slash char
                + '$';

            regex = new RegExp(regexPattern);
            this.regexCache.set(pattern, regex);
        }

        return regex.test(path);
    }

    /**
     * Clear the regex cache (call when rules change).
     */
    clearRegexCache(): void {
        this.regexCache.clear();
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
                errors.push(`Invalid source pattern: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // Validate target folder pattern if specified
        if (rule.targetFolder) {
            try {
                this.matchesGlobPattern(rule.targetFolder, 'test/path');
            } catch (e) {
                errors.push(`Invalid target folder pattern: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // Validate field name (valid YAML key — allows hyphens)
        if (rule.updateField && !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(rule.updateField)) {
            errors.push('Update field must be a valid identifier (letters, numbers, underscore, hyphen)');
        }

        // Validate priority
        if (rule.priority < 1) {
            errors.push('Priority must be at least 1');
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
