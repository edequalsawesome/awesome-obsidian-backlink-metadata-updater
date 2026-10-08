import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
class TFile {
    constructor(path) {
        this.path = path;
        this.extension = path.split('.').pop();
        this.basename = path.split('/').pop().replace(/\.[^.]+$/, '');
        this.stat = { ctime: new Date('2026-01-01').getTime() };
    }
}
class Plugin {
    registerEvent() {}
    register() {}
    addCommand(command) { (this.commands ||= []).push(command); }
    addSettingTab(tab) { this.settingTab = tab; }
    async loadData() { return this.saved; }
    async saveData(data) { this.saved = data; }
}
// Minimal host controls for exercising the real settings callbacks without a vault.
let focused;
const ownerDocument = { body: {}, get activeElement() { return focused; } };
class Element {
    constructor(tag = 'div', cls = '') { this.tag = tag; this.cls = cls; this.children = []; this.dataset = {}; this.attrs = {}; this.ownerDocument = ownerDocument; }
    createEl(tag, opts = {}) { const el = new Element(tag, opts.cls); el.textContent = opts.text; el.parentElement = this; this.children.push(el); return el; }
    createDiv(cls) { return this.createEl('div', { cls }); }
    addClass(cls) { this.cls += ' ' + cls; }
    setAttribute(name, value) { this.attrs[name] = value; }
    contains(el) { return el === this || this.children.some(child => child.contains(el)); }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    matches(selector) { return selector.split(/,\s*/).some(part => part.startsWith('.') ? this.cls?.split(' ').includes(part.slice(1)) : part === '[data-control=target-type]' ? this.dataset.control === 'target-type' : this.tag === part); }
    empty() { for (const child of this.children) child.remove(); }
    remove() { if (this.contains(focused)) focused = this.ownerDocument.body; this.parentElement.children = this.parentElement.children.filter(el => el !== this); this.parentElement = null; }
    set disabled(value) { this._disabled = value; if (value && focused === this) focused = this.ownerDocument.body; }
    get disabled() { return this._disabled || false; }
    focus() { if (!this.disabled) focused = this; }
    querySelectorAll(selector) {
        const matches = el => el.matches(selector);
        return this.children.flatMap(el => [...(matches(el) ? [el] : []), ...el.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Control {
    constructor(parent, tag = 'input') { this.el = parent.createEl(tag); this.inputEl = this.selectEl = this.buttonEl = this.el; }
    setValue(value) { this.el.value = value; return this; }
    setPlaceholder() { return this; }
    addOption() { return this; }
    setClass(cls) { this.el.addClass(cls); return this; }
    setButtonText(text) { this.el.textContent = text; return this; }
    onChange(callback) { this.el.change = callback; return this; }
    onClick(callback) { this.el.onclick = callback; return this; }
}
class Setting {
    constructor(parent) { this.row = parent.createDiv('setting'); }
    setName(name) { this.row.name = name; return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addText(callback) { callback(new Control(this.row)); return this; }
    addToggle(callback) { callback(new Control(this.row)); return this; }
    addDropdown(callback) { callback(new Control(this.row, 'select')); return this; }
    addButton(callback) { callback(new Control(this.row, 'button')); return this; }
}
const notices = [];
let openedModal;
const obsidian = {
    TFile, Plugin, PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
    Modal: class { constructor() { this.contentEl = new Element(); } open() { openedModal = this; this.onOpen(); } close() { this.onClose(); } }, FuzzySuggestModal: class { constructor() { this.contentEl = new Element(); } open() { openedModal = this; this.onOpen(); } close() { this.onClose(); } }, Notice: class { constructor(message) { notices.push(message); } }, Setting, ButtonComponent: class extends Control { constructor(parent) { super(parent, 'button'); } },
    moment: require('moment'),
    getAllTags: cache => [...(cache.tags || []).map(t => t.tag), ...(Array.isArray(cache.frontmatter?.tags) ? cache.frontmatter.tags : (cache.frontmatter?.tags || '').split(/[ ,]+/)).filter(Boolean).map(t => '#' + t.replace(/^#/, ''))],
    getLinkpath: link => link.split('#')[0],
};
const bundled = await build({
    stdin: { contents: `export { default as Plugin } from './main'; export { BacklinkProcessor } from './src/processor/backlink-processor'; export { RuleEngine } from './src/engine/rule-engine'; export { DateExtractor } from './src/utils/date-extractor'; export { DEFAULT_SETTINGS } from './src/types';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'],
});
const module = { exports: {} };
runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'obsidian' ? obsidian : require(name), console: { ...console, error: () => {} }, setTimeout, clearTimeout, Date });
const { BacklinkProcessor, RuleEngine, DateExtractor, DEFAULT_SETTINGS } = module.exports;
const options = { ...DEFAULT_SETTINGS.options, preserveHistory: false };
const rule = { id: 'test', name: 'Test', enabled: true, sourcePattern: 'Sources/*', targetFolder: 'Targets', updateField: 'references', valueType: 'append_unique_link', priority: 1 };
function vault() {
    const source = new TFile('Sources/2026-10-07.md');
    const target = new TFile('Targets/note.md');
    const files = new Map([[source.path, source], [target.path, target]]);
    const caches = new Map([[source.path, { links: [{ link: target.path }], frontmatter: {} }], [target.path, { frontmatter: {} }]]);
    const app = {
        vault: { getAbstractFileByPath: p => files.get(p), getMarkdownFiles: () => [...files.values()] },
        metadataCache: { getFileCache: f => caches.get(f.path), getFirstLinkpathDest: p => files.get(p), resolvedLinks: {} },
        fileManager: { processFrontMatter: async (f, callback) => callback(caches.get(f.path).frontmatter) },
    };
    const engine = new RuleEngine(app);
    const date = new DateExtractor(app);
    const processor = new BacklinkProcessor(app, date, engine);
    return { source, target, files, caches, app, engine, date, processor };
}

test('configured dates are compared chronologically, including date/title values', async () => {
    const { source, target, caches, date, processor } = vault();
    date.setDateFormat('DD/MM/YYYY');
    caches.get(target.path).frontmatter.lastSeen = '30/09/2026';
    const dateOptions = { ...options, dateFormat: 'DD/MM/YYYY' };
    await processor.processFile(source, [{ ...rule, updateField: 'lastSeen', valueType: 'date' }], dateOptions);
    assert.equal(caches.get(target.path).frontmatter.lastSeen, '07/10/2026');
    caches.get(target.path).frontmatter.lastSeen = { date: '30/09/2026', title: 'Old' };
    await processor.processFile(source, [{ ...rule, updateField: 'lastSeen', valueType: 'date_and_title' }], dateOptions);
    assert.equal(caches.get(target.path).frontmatter.lastSeen.date, '07/10/2026');
});

test('scalar history is preserved and repeated processing does not duplicate history', async () => {
    const { source, target, caches, processor } = vault();
    caches.get(target.path).frontmatter.referencesHistory = 'legacy entry';
    await processor.processFile(source, [rule], { ...options, preserveHistory: true });
    await processor.processFile(source, [rule], { ...options, preserveHistory: true });
    assert.equal(caches.get(target.path).frontmatter.referencesHistory.length, 2);
    assert.equal(caches.get(target.path).frontmatter.referencesHistory[0], 'legacy entry');
});

test('validation checks each rule and rejects reserved metadata keys', () => {
    const { engine } = vault();
    for (const invalid of [{ updateField: '' }, { updateField: '__proto__' }, { updateField: 'constructor' }, { priority: NaN }, { valueType: 'custom' }]) {
        assert.equal(engine.validateRuleSet([{ ...rule, ...invalid }]).isValid, false);
    }
});

test('removed links tolerate nulls and remove date/title objects with provenance', async () => {
    const { source, target, caches, processor } = vault();
    const fm = caches.get(target.path).frontmatter;
    caches.get(source.path).links = [];
    fm.references = [null, `[[${source.path}]]`, 'keep'];
    await processor.cleanupRemovedLinks(source, [target.path], [rule], { ...options, updateOnDelete: true });
    assert.equal(JSON.stringify(fm.references), '[null,"keep"]');
    fm.references = { date: '2026-10-07', source: `[[${source.path}]]` };
    await processor.cleanupRemovedLinks(source, [target.path], [{ ...rule, valueType: 'date_and_title' }], { ...options, updateOnDelete: true });
    assert.equal(fm.references, undefined);
});

test('target tags accept Obsidian frontmatter tag representations', () => {
    const { source, target, caches, engine } = vault();
    for (const tags of ['movie, book', '#movie', ['#movie', 'book']]) {
        caches.get(target.path).frontmatter.tags = tags;
        assert.equal(engine.findApplicableRules(source, target, [{ ...rule, targetFolder: undefined, targetTag: '#movie' }]).length, 1);
    }
});

test('frontmatter write failures reach the command caller', async () => {
    const { source, app, processor } = vault();
    app.fileManager.processFrontMatter = async () => { throw new Error('read-only vault'); };
    await assert.rejects(processor.processFile(source, [rule], options), /read-only vault/);
});

test('automatic updates use indexed metadata and clean removed links', async () => {
    const { source, target, caches, app } = vault();
    const handlers = new Map();
    let ready;
    app.metadataCache.on = (event, callback) => { handlers.set('metadata:' + event, callback); };
    app.vault.on = (event, callback) => { handlers.set('vault:' + event, callback); };
    app.workspace = { onLayoutReady: callback => { ready = callback; } };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    plugin.saved = { rules: [rule], options: { ...options, updateOnDelete: true, debounceMs: 1 } };
    await plugin.onload();
    caches.get(source.path).links = [];
    ready();
    caches.get(source.path).links = [{ link: target.path }];
    assert.equal(handlers.has('metadata:changed'), true);
    // The first indexed edit adds a new reference; a later edit removes it.
    await handlers.get('metadata:changed')(source);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(caches.get(target.path).frontmatter.references[0], `[[${source.path}]]`);
    caches.get(source.path).links = [];
    await plugin.handleFileModify(source);
    assert.equal(caches.get(target.path).frontmatter.references, undefined);
    plugin.onunload();
});

test('question-mark globs and rule-set validation use the same matcher', () => {
    const { engine } = vault();
    assert.equal(engine.matchesSourcePattern({ ...rule, sourcePattern: 'Sources/202?-10-07.md' }, new TFile('Sources/2026-10-07.md')), true);
});

test('reciprocal append rules settle after indexed generated writes', async () => {
    const { source, target, caches, app } = vault();
    app.metadataCache.on = app.vault.on = () => {};
    let ready;
    app.workspace = { onLayoutReady: callback => { ready = callback; } };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    const broadRule = { ...rule, sourcePattern: '**', targetFolder: undefined, valueType: 'append_link' };
    plugin.saved = { rules: [broadRule], options: { ...options, preserveHistory: true, debounceMs: 1 } };
    await plugin.onload();
    caches.get(source.path).links = [];
    ready();
    caches.get(source.path).links = [{ link: target.path }];
    let writes = 0;
    app.fileManager.processFrontMatter = async (file, callback) => {
        assert.ok(++writes <= 4, 'generated writes must settle');
        const cache = caches.get(file.path);
        callback(cache.frontmatter);
        cache.frontmatterLinks = cache.frontmatter.references.map(link => ({ link: link.slice(2, -2), key: 'references.0' }));
        await plugin.handleFileModify(file);
    };
    await plugin.handleFileModify(source);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(writes, 1);
    assert.equal(caches.get(target.path).frontmatter.references.length, 1);
    assert.equal(caches.get(source.path).frontmatter.references, undefined);
    plugin.onunload();
});

test('a running timer cannot erase a newer timer and unload cancels the newer work', async () => {
    const { source, processor } = vault();
    let release, started;
    const began = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    let calls = 0;
    processor.processFile = async () => { calls++; started(); await blocked; };
    processor.scheduleProcessing(source, [rule], { ...options, debounceMs: 1 });
    await began;
    processor.scheduleProcessing(source, [rule], { ...options, debounceMs: 50 });
    release();
    await Promise.resolve();
    assert.equal(processor.processingQueue.size, 1);
    processor.cancelAllProcessing();
    await new Promise(resolve => setTimeout(resolve, 65));
    assert.equal(calls, 1);
});

test('unload stops remaining targets after an in-flight write', async () => {
    const { source, target, files, caches, app, processor } = vault();
    const other = new TFile('Targets/other.md');
    files.set(other.path, other);
    caches.set(other.path, { frontmatter: {} });
    caches.get(source.path).links.push({ link: other.path });
    let writes = 0;
    app.fileManager.processFrontMatter = async (file, callback) => {
        writes++;
        callback(caches.get(file.path).frontmatter);
        processor.cancelAllProcessing();
    };
    await processor.processFile(source, [rule], options);
    assert.equal(writes, 1);
    assert.equal(caches.get(target.path).frontmatter.references.length, 1);
    assert.equal(caches.get(other.path).frontmatter.references, undefined);
});

test('source deletion and renaming remove the old source reference', async () => {
    const { source, target, files, caches, app } = vault();
    app.metadataCache.on = app.vault.on = () => {};
    let ready;
    app.workspace = { onLayoutReady: callback => { ready = callback; } };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    plugin.saved = { rules: [rule], options: { ...options, updateOnDelete: true, debounceMs: 1 } };
    await plugin.onload();
    ready();
    const fm = caches.get(target.path).frontmatter;
    fm.references = [`[[${source.path}]]`];
    files.delete(source.path);
    await plugin.handleFileDelete(source);
    assert.equal(fm.references, undefined);
    files.set(source.path, source);
    plugin.cacheSource(source);
    fm.references = [`[[${source.path}]]`];
    const oldPath = source.path;
    files.delete(oldPath);
    source.path = 'Sources/renamed.md';
    files.set(source.path, source);
    caches.set(source.path, caches.get(oldPath));
    await plugin.handleFileRename(source, oldPath);
    assert.equal(fm.references, undefined);
    plugin.onunload();
});

test('link subpaths resolve to their note and attachments are never mutated', async () => {
    const { source, target, files, caches, processor } = vault();
    const image = new TFile('Targets/image.png');
    files.set(image.path, image);
    caches.set(image.path, { frontmatter: {} });
    caches.get(source.path).links = [{ link: target.path + '#Heading' }, { link: image.path }];
    await processor.processFile(source, [rule], options);
    assert.equal(caches.get(target.path).frontmatter.references.length, 1);
    assert.equal(caches.get(image.path).frontmatter.references, undefined);
});


test('Cancel isolates drafts; target switching keeps focus and a connected announcement', async () => {
    const { app } = vault();
    app.workspace = { onLayoutReady: () => {} };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    plugin.saved = { rules: [rule], options };
    await plugin.onload();
    const tab = plugin.settingTab;
    tab.containerEl = new Element();
    tab.display();
    let row = tab.containerEl.querySelector('.rule-container');
    row.querySelector('button').onclick();
    const editor = row.querySelector('.rule-editor');
    editor.children.find(el => el.name === 'Update Field').querySelector('input').change('draftField');
    assert.equal(plugin.settings.rules[0].updateField, 'references');
    const type = editor.querySelector('[data-control=target-type]');
    type.change('tag');
    assert.equal(focused, row.querySelector('[data-control=target-type]'));
    assert.equal(row.querySelector('.sr-live-region').textContent, 'Target type changed to tag.');
    row.querySelector('.rule-editor').querySelectorAll('button').find(el => el.textContent === 'Cancel').onclick();
    assert.equal(row.querySelector('.rule-editor'), null);
    assert.equal(focused, row.querySelector('button'));
    assert.equal(plugin.settings.rules[0].updateField, 'references');
    row.querySelector('button').onclick();
    row.querySelector('.rule-editor').children.find(el => el.name === 'Update Field').querySelector('input').change('savedField');
    await row.querySelector('.rule-editor').querySelectorAll('button').find(el => el.textContent === 'Save').onclick();
    assert.equal(plugin.settings.rules[0].updateField, 'savedField');
    row = tab.containerEl.querySelector('.rule-container');
    assert.equal(focused, row.querySelector('button'));
});

test('same-source date/title corrections refresh while other-source ties stay stable', async () => {
    const { source, target, caches, processor } = vault();
    const dateRule = { ...rule, valueType: 'date_and_title' };
    await processor.processFile(source, [dateRule], options);
    caches.get(source.path).frontmatter.title = 'Corrected title';
    await processor.processFile(source, [dateRule], options);
    assert.equal(caches.get(target.path).frontmatter.references.title, 'Corrected title');
    caches.get(target.path).frontmatter.references = { date: '2026-10-07', title: 'Other source', source: '[[other.md]]' };
    await processor.processFile(source, [dateRule], options);
    assert.equal(caches.get(target.path).frontmatter.references.title, 'Other source');
});

test('cleanup waits for older writes and removes their stale reference', async () => {
    const { source, target, caches, app, processor } = vault();
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    let first = true;
    app.fileManager.processFrontMatter = async (file, callback) => {
        if (first) { first = false; started(); await blocked; }
        callback(caches.get(file.path).frontmatter);
    };
    const processing = processor.processFile(source, [rule], options);
    await began;
    caches.get(source.path).links = [];
    const cleaning = processor.cleanupRemovedLinks(source, [target.path], [rule], { ...options, updateOnDelete: true });
    release();
    await Promise.all([processing, cleaning]);
    assert.equal(caches.get(target.path).frontmatter.references, undefined);
});

test('failed scheduled processing retries on a later indexed event', async () => {
    const { source, target, caches, app } = vault();
    app.metadataCache.on = app.vault.on = () => {};
    let ready;
    app.workspace = { onLayoutReady: callback => { ready = callback; } };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    plugin.saved = { rules: [rule], options: { ...options, debounceMs: 1 } };
    await plugin.onload();
    caches.get(source.path).links = [];
    ready();
    caches.get(source.path).links = [{ link: target.path }];
    app.fileManager.processFrontMatter = async () => { throw new Error('temporary write failure'); };
    await plugin.handleFileModify(source);
    // Repeat before failure to verify equivalent events keep the scheduled identity.
    await plugin.handleFileModify(source);
    await new Promise(resolve => setTimeout(resolve, 15));
    app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
    await plugin.handleFileModify(source);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(caches.get(target.path).frontmatter.references[0], `[[${source.path}]]`);
    plugin.onunload();
});

test('enabling a rule seeds cleanup baselines and extension renames clean the old identity', async () => {
    const { source, target, caches, app } = vault();
    app.metadataCache.on = app.vault.on = () => {};
    let ready;
    app.workspace = { onLayoutReady: callback => { ready = callback; } };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    plugin.saved = { rules: [{ ...rule, enabled: false }], options: { ...options, updateOnDelete: true } };
    await plugin.onload();
    ready();
    plugin.settings.rules[0].enabled = true;
    await plugin.saveSettings();
    await plugin.processor.processFile(source, plugin.settings.rules, plugin.settings.options);
    caches.get(source.path).links = [];
    await plugin.handleFileModify(source);
    assert.equal(caches.get(target.path).frontmatter.references, undefined);
    caches.get(source.path).links = [{ link: target.path }];
    plugin.cacheSource(source);
    await plugin.processor.processFile(source, plugin.settings.rules, plugin.settings.options);
    const oldPath = source.path;
    source.path = 'Sources/2026-10-07.txt';
    source.extension = 'txt';
    await plugin.handleFileRename(source, oldPath);
    assert.equal(caches.get(target.path).frontmatter.references, undefined);
    assert.equal(plugin.fileContentCache.has(oldPath), false);
    plugin.onunload();
});

test('legacy ISO dates and unknown existing dates survive a format change', async () => {
    const { source, target, caches, date, processor } = vault();
    date.setDateFormat('DD/MM/YYYY');
    caches.get(source.path).frontmatter.date = '2026-09-30';
    const changedOptions = { ...options, dateFormat: 'DD/MM/YYYY' };
    const dateRule = { ...rule, valueType: 'date' };
    for (const existing of ['2026-10-07', 'unrecognized legacy date']) {
        caches.get(target.path).frontmatter.references = existing;
        await processor.processFile(source, [dateRule], changedOptions);
        assert.equal(caches.get(target.path).frontmatter.references, existing);
    }
});

test('saving one rule retains other drafts and failed persistence rolls back the active rule', async () => {
    const { app } = vault();
    app.workspace = { onLayoutReady: () => {} };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    plugin.saved = { rules: [rule, { ...rule, id: 'second', name: 'Second' }], options };
    await plugin.onload();
    const tab = plugin.settingTab;
    tab.containerEl = new Element();
    tab.display();
    let rows = tab.containerEl.querySelectorAll('.rule-container');
    rows.forEach(row => row.querySelector('button').onclick());
    const field = row => row.querySelector('.rule-editor').children.find(el => el.name === 'Update Field').querySelector('input');
    const save = row => row.querySelector('.rule-editor').querySelectorAll('button').find(el => el.textContent === 'Save');
    field(rows[0]).change('firstSaved');
    field(rows[1]).change('secondDraft');
    await save(rows[0]).onclick();
    rows = tab.containerEl.querySelectorAll('.rule-container');
    assert.equal(field(rows[1]).value, 'secondDraft');
    plugin.saveData = async () => { throw new Error('settings read-only'); };
    await save(rows[1]).onclick();
    assert.equal(plugin.settings.rules[1].updateField, 'references');
    assert.equal(save(rows[1]).disabled, false);
    rows[1].querySelector('.rule-editor').querySelectorAll('button').find(el => el.textContent === 'Cancel').onclick();
    assert.equal(plugin.settings.rules[1].updateField, 'references');
});

test('three-note replacement cycles exclude generated links while later user edits still process', async () => {
    const { source, target, files, caches, app } = vault();
    const third = new TFile('Targets/third.md');
    files.set(third.path, third);
    caches.set(third.path, { links: [{ link: source.path }], frontmatter: {} });
    caches.get(target.path).links = [{ link: third.path }];
    app.metadataCache.on = app.vault.on = () => {};
    let ready;
    app.workspace = { onLayoutReady: callback => { ready = callback; } };
    const plugin = new module.exports.Plugin();
    plugin.app = app;
    const broadRule = { ...rule, sourcePattern: '**', targetFolder: undefined, updateField: 'title', valueType: 'replace_link' };
    plugin.saved = { rules: [broadRule], options: { ...options, preserveHistory: true, debounceMs: 1 } };
    await plugin.onload();
    caches.get(source.path).links = [];
    ready();
    caches.get(source.path).links = [{ link: target.path }];
    let writes = 0;
    app.fileManager.processFrontMatter = async (file, callback) => {
        assert.ok(++writes < 8, 'replacement cycles must settle');
        const cache = caches.get(file.path);
        callback(cache.frontmatter);
        cache.frontmatterLinks = [{ key: 'title', link: cache.frontmatter.title.slice(2, -2) },
            ...cache.frontmatter.titleHistory.map(entry => ({ key: 'titleHistory.0.value', link: entry.value.slice(2, -2) }))];
        await plugin.handleFileModify(file);
    };
    await plugin.handleFileModify(source);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(writes, 1);
    caches.get(source.path).links = [{ link: third.path }];
    await plugin.handleFileModify(source);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(writes, 2);
    assert.equal(caches.get(third.path).frontmatter.title, `[[${source.path}]]`);
    plugin.onunload();
});

async function loadedPlugin(state, extra = {}) {
    state.app.metadataCache.on = state.app.vault.on = () => {};
    let ready;
    state.app.workspace = { onLayoutReady: callback => { ready = callback; } };
    const plugin = new module.exports.Plugin();
    plugin.app = state.app;
    plugin.saved = { rules: [rule], options: { ...options, updateOnDelete: true, debounceMs: 1, ...extra } };
    await plugin.onload();
    ready();
    return plugin;
}
const waitForTimers = () => new Promise(resolve => setTimeout(resolve, 15));
const editorField = row => row.querySelector('.rule-editor').children.find(el => el.name === 'Update Field').querySelector('input');
const editorButton = (row, name) => row.querySelector('.rule-editor').querySelectorAll('button').find(el => el.textContent === name);
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('overlapping failed removals retain targets independently and skip re-added links', async () => {
    const state = vault();
    const { source, target, files, caches, app } = state;
    const other = new TFile('Targets/other.md');
    files.set(other.path, other);
    caches.set(other.path, { frontmatter: {} });
    caches.get(source.path).links.push({ link: other.path });
    const plugin = await loadedPlugin(state);
    caches.get(other.path).frontmatter.references = [`[[${source.path}]]`];
    const blocked = deferred();
    app.fileManager.processFrontMatter = async () => blocked.promise;
    caches.get(source.path).links = [{ link: target.path }];
    const first = plugin.handleFileModify(source);
    await Promise.resolve();
    caches.get(source.path).links.push({ link: 'Targets/new.md' });
    const second = plugin.handleFileModify(source);
    blocked.reject(new Error('temporary failure'));
    await Promise.all([first, second]);
    assert.equal(plugin.pendingCleanup.size, 1);
    app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
    await plugin.handleFileModify(source);
    assert.equal(caches.get(other.path).frontmatter.references, undefined);
    assert.equal(plugin.pendingCleanup.size, 0);
    // A failed removal followed by re-adding the link must retain its reference.
    plugin.cacheSource(source);
    caches.get(target.path).frontmatter.references = [`[[${source.path}]]`];
    caches.get(source.path).links = [];
    app.fileManager.processFrontMatter = async () => { throw new Error('temporary failure'); };
    await plugin.handleFileModify(source);
    caches.get(source.path).links = [{ link: target.path }];
    app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
    await plugin.handleFileModify(source);
    assert.equal(caches.get(target.path).frontmatter.references[0], `[[${source.path}]]`);
    plugin.onunload();
});

test('deleted and renamed identities retain failed cleanup with bounded explicit or indexed retries', async () => {
    for (const rename of [false, true]) {
        const state = vault();
        const { source, target, files, caches, app } = state;
        const plugin = await loadedPlugin(state);
        const oldPath = source.path;
        caches.get(target.path).frontmatter.references = [`[[${oldPath}]]`];
        let attempts = 0;
        app.fileManager.processFrontMatter = async () => { attempts++; throw new Error('read-only'); };
        files.delete(oldPath);
        if (rename) {
            source.path = 'Sources/renamed.md';
            files.set(source.path, source);
            caches.set(source.path, caches.get(oldPath));
            await plugin.handleFileRename(source, oldPath);
        } else await plugin.handleFileDelete(source);
        await waitForTimers();
        const before = attempts;
        await waitForTimers();
        assert.equal(attempts, before, 'no automatic retry loop');
        assert.equal(plugin.pendingCleanup.size, 1);
        assert.ok(notices.some(message => message.includes(oldPath) && message.includes('Retry pending backlink cleanup')));
        source.path = 'Sources/mutated-again.md';
        app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
        if (rename) await plugin.handleFileModify(target);
        else await plugin.commands.find(command => command.id === 'retry-pending-backlink-cleanup').callback();
        assert.equal(caches.get(target.path).frontmatter.references, undefined);
        assert.equal(plugin.pendingCleanup.size, 0);
        plugin.onunload();
        await plugin.commands.find(command => command.id === 'retry-pending-backlink-cleanup').callback();
    }
});

test('failed rename timer invalidates its captured snapshot and retries on indexing', async () => {
    const state = vault();
    const { source, target, files, caches, app } = state;
    const plugin = await loadedPlugin(state);
    const oldPath = source.path;
    files.delete(oldPath);
    source.path = 'Sources/renamed.md';
    files.set(source.path, source);
    caches.set(source.path, caches.get(oldPath));
    caches.get(target.path).frontmatter.references = [`[[${oldPath}]]`];
    let writes = 0;
    app.fileManager.processFrontMatter = async (file, callback) => {
        if (++writes > 1) throw new Error('temporary failure');
        callback(caches.get(file.path).frontmatter);
    };
    await plugin.handleFileRename(source, oldPath);
    assert.equal(caches.get(target.path).frontmatter.references, undefined);
    assert.equal(plugin.pendingCleanup.size, 0);
    await waitForTimers();
    assert.equal(plugin.fileContentCache.get(source.path).signature, '');
    assert.ok(notices.some(message => message.includes(`Backlink update failed for ${source.path}`) && message.includes('retry')));
    app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
    await plugin.handleFileModify(source);
    await waitForTimers();
    assert.equal(caches.get(target.path).frontmatter.references[0], `[[${source.path}]]`);
    plugin.onunload();
});

test('pending Save preserves newer edits, replacement drafts, and guards concurrent clicks', async () => {
    for (const reopen of [false, true]) {
        const plugin = await loadedPlugin(vault());
        const tab = plugin.settingTab;
        tab.containerEl = new Element();
        tab.display();
        let row = tab.containerEl.querySelector('.rule-container');
        row.querySelector('button').onclick();
        editorField(row).change('savedField');
        const pending = deferred();
        let saves = 0;
        plugin.saveData = async () => { saves++; await pending.promise; };
        const button = editorButton(row, 'Save');
        const saving = button.onclick();
        await button.onclick();
        assert.equal(saves, 1);
        if (reopen) {
            editorButton(row, 'Cancel').onclick();
            row.querySelector('button').onclick();
        }
        editorField(row).change('newerDraft');
        pending.resolve();
        await saving;
        assert.equal(plugin.settings.rules[0].updateField, 'savedField');
        tab.display();
        row = tab.containerEl.querySelector('.rule-container');
        assert.equal(editorField(row).value, 'newerDraft');
        plugin.onunload();
    }
});

test('failed Save restores lost button focus without stealing moved focus', async () => {
    for (const moveFocus of [false, true]) {
        const plugin = await loadedPlugin(vault());
        const tab = plugin.settingTab;
        tab.containerEl = new Element();
        tab.display();
        const row = tab.containerEl.querySelector('.rule-container');
        row.querySelector('button').onclick();
        const save = editorButton(row, 'Save');
        const pending = deferred();
        plugin.saveData = async () => pending.promise;
        save.focus();
        const saving = save.onclick();
        assert.equal(focused, ownerDocument.body);
        const input = editorField(row);
        if (moveFocus) input.focus();
        pending.reject(new Error('read-only'));
        await saving;
        assert.equal(focused, moveFocus ? input : save);
        assert.equal(save.disabled, false);
        plugin.onunload();
    }
});

test('unload abandons pending cleanup without starting more target writes or notices', async () => {
    const state = vault();
    const { source, target, files, caches, app } = state;
    const other = new TFile('Targets/other.md');
    files.set(other.path, other);
    caches.set(other.path, { frontmatter: { references: [`[[${source.path}]]`] } });
    caches.get(source.path).links.push({ link: other.path });
    const plugin = await loadedPlugin(state);
    const blocked = deferred();
    let writes = 0;
    app.fileManager.processFrontMatter = async () => { writes++; await blocked.promise; };
    caches.get(source.path).links = [];
    const cleaning = plugin.handleFileModify(source);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(writes, 1);
    const noticeCount = notices.length;
    plugin.onunload();
    blocked.reject(new Error('unloaded'));
    await cleaning;
    await plugin.handleFileModify(target);
    await plugin.handleFileDelete(source);
    await plugin.retryCleanup();
    assert.equal(writes, 1);
    assert.equal(notices.length, noticeCount);
    assert.equal(plugin.pendingCleanup.size, 0);
});


test('disabled cleanup retains pending work through indexed and explicit retries', async () => {
    const state = vault();
    const { source, target, caches, app } = state;
    const plugin = await loadedPlugin(state);
    caches.get(target.path).frontmatter.references = [`[[${source.path}]]`];
    caches.get(source.path).links = [];
    app.fileManager.processFrontMatter = async () => { throw new Error('read-only'); };
    await plugin.handleFileModify(source);
    plugin.settings.options.updateOnDelete = false;
    await plugin.handleFileModify(target);
    await plugin.retryCleanup();
    assert.equal(plugin.pendingCleanup.size, 1);
    plugin.settings.options.updateOnDelete = true;
    app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
    await plugin.retryCleanup();
    assert.equal(plugin.pendingCleanup.size, 0);
    assert.equal(caches.get(target.path).frontmatter.references, undefined);
    plugin.onunload();
});

test('failed deletion and rename cleanup preserve restored old-path references', async () => {
    for (const rename of [false, true]) {
        const state = vault();
        const { source, target, files, caches, app } = state;
        const plugin = await loadedPlugin(state);
        const oldPath = source.path;
        caches.get(target.path).frontmatter.references = [`[[${oldPath}]]`];
        app.fileManager.processFrontMatter = async () => { throw new Error('read-only'); };
        files.delete(oldPath);
        if (rename) {
            source.path = 'Sources/renamed.md';
            files.set(source.path, source);
            caches.set(source.path, caches.get(oldPath));
            await plugin.handleFileRename(source, oldPath);
            await waitForTimers();
            files.delete(source.path);
            source.path = oldPath;
        } else await plugin.handleFileDelete(source);
        files.set(oldPath, source);
        app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
        plugin.seedSourceCache();
        await plugin.processor.processFile(source, plugin.settings.rules, plugin.settings.options);
        await plugin.retryCleanup();
        await plugin.handleFileModify(source);
        await waitForTimers();
        assert.equal(caches.get(target.path).frontmatter.references[0], `[[${oldPath}]]`);
        assert.equal(plugin.pendingCleanup.size, 0);
        plugin.onunload();
    }
});

test('queued cleanup reconciles restored links after waiting and pauses when disabled', async () => {
    for (const restore of [false, true]) {
        const { source, target, caches, app, processor } = vault();
        const blocked = deferred();
        const began = deferred();
        app.fileManager.processFrontMatter = async (file, callback) => { began.resolve(); await blocked.promise; callback(caches.get(file.path).frontmatter); };
        const processing = processor.processFile(source, [rule], options);
        await began.promise;
        caches.get(source.path).links = [];
        const cleanupOptions = { ...options, updateOnDelete: true };
        const cleaning = processor.cleanupRemovedLinks(source, [target.path], [rule], cleanupOptions);
        if (restore) caches.get(source.path).links = [{ link: target.path }];
        else cleanupOptions.updateOnDelete = false;
        blocked.resolve();
        await processing;
        assert.equal(await cleaning, restore);
        assert.equal(caches.get(target.path).frontmatter.references[0], `[[${source.path}]]`);
    }
});

test('cleanup pauses between targets and can finish after re-enabling', async () => {
    const state = vault();
    const { source, target, files, caches, app } = state;
    const other = new TFile('Targets/other.md');
    files.set(other.path, other);
    caches.set(other.path, { frontmatter: { references: [`[[${source.path}]]`] } });
    caches.get(source.path).links.push({ link: other.path });
    const plugin = await loadedPlugin(state);
    caches.get(target.path).frontmatter.references = [`[[${source.path}]]`];
    caches.get(source.path).links = [];
    app.fileManager.processFrontMatter = async (file, callback) => {
        callback(caches.get(file.path).frontmatter);
        plugin.settings.options.updateOnDelete = false;
    };
    await plugin.handleFileModify(source);
    assert.equal(plugin.pendingCleanup.size, 1);
    assert.ok(caches.get(other.path).frontmatter.references);
    plugin.settings.options.updateOnDelete = true;
    app.fileManager.processFrontMatter = async (file, callback) => callback(caches.get(file.path).frontmatter);
    await plugin.retryCleanup();
    assert.equal(plugin.pendingCleanup.size, 0);
    assert.equal(caches.get(other.path).frontmatter.references, undefined);
    plugin.onunload();
});

test('Add Delete and option failures are handled visibly and preserve existing drafts', async () => {
    const plugin = await loadedPlugin(vault());
    const tab = plugin.settingTab;
    tab.containerEl = new Element();
    tab.display();
    const row = tab.containerEl.querySelector('.rule-container');
    row.querySelector('button').onclick();
    editorField(row).change('recoverableDraft');
    plugin.saveData = async () => { throw new Error('read-only settings'); };
    const noticeStart = notices.length;
    tab.addNewRule();
    await waitForTimers();
    assert.equal(plugin.settings.rules.length, 1);
    assert.equal(editorField(tab.containerEl.querySelector('.rule-container')).value, 'recoverableDraft');
    tab.confirmDeleteRule(0, 'Test');
    openedModal.contentEl.querySelectorAll('button').find(button => button.textContent === 'Delete').onclick();
    await waitForTimers();
    assert.equal(plugin.settings.rules.length, 1);
    assert.equal(editorField(tab.containerEl.querySelector('.rule-container')).value, 'recoverableDraft');
    for (const name of ['Preserve history', 'Update on delete', 'Enable logging']) {
        await tab.containerEl.children.find(el => el.name === name).querySelector('input').change(false);
    }
    tab.containerEl.children.find(el => el.name === 'Date format').querySelector('input').change('DD/MM/YYYY');
    tab.hide();
    await waitForTimers();
    const failures = notices.slice(noticeStart);
    assert.ok(failures.some(message => message.includes('Could not add rule')));
    assert.ok(failures.some(message => message.includes('Could not delete rule')));
    assert.equal(failures.filter(message => message.includes('not saved')).length, 4);
    plugin.onunload();
});

test('active date format reaches extraction and processing before debounce and after failed save', async () => {
    for (const valueType of ['date', 'date_and_title']) {
        const state = vault();
        const plugin = await loadedPlugin(state);
        plugin.settings.rules[0].valueType = valueType;
        const tab = plugin.settingTab;
        tab.containerEl = new Element();
        tab.display();
        let reseeds = 0;
        plugin.seedSourceCache = () => { reseeds++; };
        plugin.saveData = async () => { throw new Error('read-only'); };
        const before = plugin.cacheSource(state.source).signature;
        tab.containerEl.children.find(el => el.name === 'Date format').querySelector('input').change('DD/MM/YYYY');
        assert.equal(reseeds, 0);
        assert.notEqual(plugin.cacheSource(state.source).signature, before);
        assert.equal(plugin.dateExtractor.extractDate(state.source), '07/10/2026');
        for (const failedSave of [false, true]) {
            if (failedSave) { tab.hide(); await waitForTimers(); }
            delete state.caches.get(state.target.path).frontmatter.references;
            await plugin.processor.processFile(state.source, plugin.settings.rules, plugin.settings.options);
            const result = state.caches.get(state.target.path).frontmatter.references;
            assert.equal(valueType === 'date' ? result : result.date, '07/10/2026');
        }
        plugin.settings.options.dateFormat = 'YYYY.MM.DD';
        await tab.saveOptions();
        assert.equal(plugin.dateExtractor.extractDate(state.source), '2026.10.07');
        assert.equal(reseeds, 0);
        plugin.onunload();
    }
});

test('failed deferred Add/Delete restores current connected control and preserves outside focus', async () => {
    for (const action of ['add', 'delete']) {
        for (const destination of ['new-rule', 'draft', 'global', 'outside']) {
            if (action === 'delete' && destination === 'new-rule') continue;
            const plugin = await loadedPlugin(vault());
            plugin.settings.rules.push({ ...rule, id: 'other-rule' });
            const tab = plugin.settingTab;
            tab.containerEl = new Element();
            tab.display();
            const otherRow = tab.containerEl.querySelectorAll('.rule-container')[1];
            otherRow.querySelector('button').onclick();
            editorField(otherRow).change('retainedDraft');
            const pending = deferred();
            plugin.saveData = () => pending.promise;
            if (action === 'add') tab.addNewRule();
            else {
                tab.confirmDeleteRule(0, 'Test');
                openedModal.contentEl.querySelectorAll('button').find(button => button.textContent === 'Delete').onclick();
            }
            const draftRow = () => tab.containerEl.querySelectorAll('.rule-container').find(row => row.dataset.ruleId === 'other-rule');
            const globalInput = () => tab.containerEl.children.find(el => el.name === 'Date format').querySelector('input');
            const outside = new Element('input');
            if (destination === 'draft') editorField(draftRow()).focus();
            if (destination === 'global') globalInput().focus();
            if (destination === 'outside') outside.focus();
            const oldFocus = focused;
            pending.reject(new Error('read-only'));
            await waitForTimers();
            const expected = destination === 'new-rule' ? tab.containerEl.querySelector('.add-rule-button')
                : destination === 'draft' ? editorField(draftRow()) : destination === 'global' ? globalInput() : outside;
            assert.equal(focused, expected);
            if (destination !== 'outside') {
                assert.notEqual(focused, oldFocus);
                assert.ok(tab.containerEl.contains(focused));
            }
            assert.equal(editorField(draftRow()).value, 'retainedDraft');
            plugin.onunload();
        }
    }
});
