export interface BacklinkMetadataSettings {
    rules: Rule[];
    options: PluginOptions;
}

export interface Rule {
    id: string;
    name: string;
    sourcePattern: string;
    targetTag?: string;
    targetFolder?: string;
    updateField: string;
    valueType: ValueType;
    priority: number;
    enabled: boolean;
}

export type ValueType = 
    | 'date' 
    | 'date_and_title' 
    | 'append_link' 
    | 'append_unique_link'
    | 'replace_link'
    | 'custom';

export interface PluginOptions {
    preserveHistory: boolean;
    updateOnDelete: boolean;
    dateFormat: string;
    debounceMs: number;
    enableLogging: boolean;
}

export interface ProcessingContext {
    sourceFile: string;
    targetFile: string;
    extractedDate?: string;
    extractedTitle?: string;
    rule: Rule;
}

export interface MetadataUpdate {
    field: string;
    value: any;
    timestamp: string;
    sourceContext?: string;
}

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

export interface BacklinkCache {
    [filePath: string]: {
        outgoingLinks: string[];
        incomingLinks: string[];
        lastUpdated: number;
    };
}

export const DEFAULT_SETTINGS: BacklinkMetadataSettings = {
    rules: [
        {
            id: 'daily-to-movies',
            name: 'Daily Notes → Movies',
            sourcePattern: 'Daily Notes/*',
            targetTag: '#movie',
            updateField: 'lastWatched',
            valueType: 'date',
            priority: 1,
            enabled: true
        },
        {
            id: 'daily-to-books',
            name: 'Daily Notes → Books',
            sourcePattern: 'Daily Notes/*',
            targetTag: '#book',
            updateField: 'lastRead',
            valueType: 'date',
            priority: 1,
            enabled: true
        }
    ],
    options: {
        preserveHistory: true,
        updateOnDelete: false,
        dateFormat: 'YYYY-MM-DD',
        debounceMs: 1000,
        enableLogging: false
    }
};