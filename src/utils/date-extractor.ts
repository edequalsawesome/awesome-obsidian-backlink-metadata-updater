import { TFile, TAbstractFile, CachedMetadata } from 'obsidian';
import { moment } from 'obsidian';

export class DateExtractor {
    private app: any;

    constructor(app: any) {
        this.app = app;
    }

    /**
     * Extract date from a file, trying multiple sources in order:
     * 1. Frontmatter date field
     * 2. Filename patterns (YYYY-MM-DD, DD-MM-YYYY, etc.)
     * 3. Daily note patterns
     * 4. Creation date as fallback
     */
    extractDate(file: TFile): string | null {
        // Try frontmatter first
        const frontmatterDate = this.extractFromFrontmatter(file);
        if (frontmatterDate) return frontmatterDate;

        // Try filename patterns
        const filenameDate = this.extractFromFilename(file);
        if (filenameDate) return filenameDate;

        // Try path-based patterns (daily notes folder structure)
        const pathDate = this.extractFromPath(file);
        if (pathDate) return pathDate;

        // Fallback to file creation time
        return this.formatDate(moment(file.stat.ctime));
    }

    private extractFromFrontmatter(file: TFile): string | null {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter) return null;

        const frontmatter = cache.frontmatter;
        
        // Check common date field names
        const dateFields = ['date', 'created', 'day', 'timestamp'];
        
        for (const field of dateFields) {
            if (frontmatter[field]) {
                const parsed = this.parseDate(frontmatter[field]);
                if (parsed) return this.formatDate(parsed);
            }
        }

        return null;
    }

    private extractFromFilename(file: TFile): string | null {
        const basename = file.basename;
        
        // Common date patterns in filenames
        const patterns = [
            // YYYY-MM-DD
            /(\d{4}-\d{2}-\d{2})/,
            // DD-MM-YYYY
            /(\d{2}-\d{2}-\d{4})/,
            // YYYY.MM.DD
            /(\d{4}\.\d{2}\.\d{2})/,
            // DD.MM.YYYY
            /(\d{2}\.\d{2}\.\d{4})/,
            // YYYYMMDD
            /(\d{8})/,
            // MM/DD/YYYY
            /(\d{2}\/\d{2}\/\d{4})/,
        ];

        for (const pattern of patterns) {
            const match = basename.match(pattern);
            if (match) {
                const parsed = this.parseDate(match[1]);
                if (parsed) return this.formatDate(parsed);
            }
        }

        return null;
    }

    private extractFromPath(file: TFile): string | null {
        const path = file.path;
        
        // Look for date patterns in the path structure
        // e.g., "Daily Notes/2024/11/2024-11-15.md"
        const pathPatterns = [
            /\/(\d{4}-\d{2}-\d{2})/,
            /\/(\d{4})\/(\d{2})\/(\d{2})/,
            /\/(\d{4})\/(\d{2})/,
        ];

        for (const pattern of pathPatterns) {
            const match = path.match(pattern);
            if (match) {
                let dateStr: string;
                if (match.length === 2) {
                    // Single capture group (full date)
                    dateStr = match[1];
                } else if (match.length === 4) {
                    // Year, month, day separately
                    dateStr = `${match[1]}-${match[2]}-${match[3]}`;
                } else if (match.length === 3) {
                    // Year, month (assume first day)
                    dateStr = `${match[1]}-${match[2]}-01`;
                } else {
                    continue;
                }
                
                const parsed = this.parseDate(dateStr);
                if (parsed) return this.formatDate(parsed);
            }
        }

        return null;
    }

    private parseDate(input: string | number | Date): moment.Moment | null {
        if (!input) return null;

        // If it's already a Date object
        if (input instanceof Date) {
            return moment(input);
        }

        // If it's a timestamp
        if (typeof input === 'number') {
            return moment(input);
        }

        // Parse string dates with various formats
        const formats = [
            'YYYY-MM-DD',
            'DD-MM-YYYY',
            'MM/DD/YYYY',
            'DD/MM/YYYY',
            'YYYY.MM.DD',
            'DD.MM.YYYY',
            'YYYYMMDD',
            'YYYY-MM-DD HH:mm:ss',
            'YYYY-MM-DDTHH:mm:ss',
            'YYYY-MM-DD HH:mm',
        ];

        for (const format of formats) {
            const parsed = moment(input, format, true);
            if (parsed.isValid()) {
                return parsed;
            }
        }

        // Try moment's flexible parsing as last resort
        const parsed = moment(input);
        return parsed.isValid() ? parsed : null;
    }

    private formatDate(date: moment.Moment): string {
        return date.format('YYYY-MM-DD');
    }

    /**
     * Extract title from various sources
     */
    extractTitle(file: TFile): string | null {
        // Try frontmatter title first
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter?.title) {
            return cache.frontmatter.title;
        }

        // Check first heading
        if (cache?.headings?.[0]) {
            return cache.headings[0].heading;
        }

        // Fallback to filename without extension
        return file.basename;
    }

    /**
     * Check if file matches daily note patterns
     */
    isDailyNote(file: TFile): boolean {
        // Check common daily note patterns
        const dailyPatterns = [
            /\d{4}-\d{2}-\d{2}/, // YYYY-MM-DD
            /\d{2}-\d{2}-\d{4}/, // DD-MM-YYYY
            /\d{8}/,             // YYYYMMDD
        ];

        return dailyPatterns.some(pattern => pattern.test(file.basename));
    }

    /**
     * Validate date format
     */
    isValidDate(dateStr: string): boolean {
        const parsed = this.parseDate(dateStr);
        return parsed !== null && parsed.isValid();
    }
}