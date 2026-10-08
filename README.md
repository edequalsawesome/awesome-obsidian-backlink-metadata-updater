# Backlink Metadata Updater

An Obsidian plugin that automatically updates note metadata based on backlinks. When you mention a note in your daily notes or other contexts, the linked note's frontmatter properties are automatically updated with relevant metadata.

## Features

### Core Functionality
- **Automatic Updates**: Metadata updates after Obsidian indexes changes to source links, dates, or titles
- **Configurable Rules**: Define custom rules for different note types and contexts
- **Smart Date Extraction**: Automatically extracts dates from daily notes, filenames, and frontmatter
- **Flexible Value Types**: Support for dates, links, and date/title objects
- **History Tracking**: Optional preservation of update history

### Rule-Based System
Configure rules to control how metadata gets updated:
- **Source Patterns**: Define which files trigger updates (e.g., `Daily Notes/*`)
- **Target Criteria**: Specify which notes get updated (by tag or folder)
- **Update Fields**: Choose which metadata fields to update
- **Value Types**: Control what gets stored (date, title, links, etc.)

### Built-in Commands
- **Process All Files**: Bulk update all metadata based on existing backlinks
- **Process Current File**: Update metadata for the currently active file
- **Retry Pending Backlink Cleanup**: Retry failed removed-link, deletion, or rename cleanup while the plugin remains loaded. A later indexed event for the source or affected target also retries once; there is no automatic retry loop. Disabling Update on delete pauses pending cleanup until re-enabled; current outgoing links at a restored or renamed-back source path are preserved
- **Validate Rules**: Check rule configuration for errors and conflicts

## Quick Start

1. Install the plugin
2. Open Settings → Backlink Metadata Updater
3. Configure your first rule:
   - Source Pattern: `Daily Notes/*` (or any other folder you'd like)
   - Target Tag: `#movie` (or any tag you use)
   - Update Field: `lastWatched` (you can set this to be whatever)
   - Value Type: `date`
4. Start linking to tagged notes from other notes, and get real-time metadata updates!

## Example Rules

### Movies and Books
```yaml
# When you link to a #movie from a daily note, update its lastWatched date
Source: Daily Notes/*
Target: #movie
Field: lastWatched
Type: date

# When you link to a #book from a daily note, update its lastRead date  
Source: Daily Notes/*
Target: #book
Field: lastRead
Type: date
```

### Meeting Notes
```yaml
# When you link to a #person from meeting notes, track the meeting
Source: Meeting Notes/*
Target: #person
Field: lastMeeting
Type: date_and_title
```

### Project References
```yaml
# Track which projects reference specific resources
Source: Projects/*
Target: Resources/*
Field: referencedIn
Type: append_unique_link
```

## Configuration

### Plugin Options
- **Preserve History**: Keep track of all updates in separate history fields
- **Update on Delete**: Remove generated source links and date/title objects when a source link is removed, a source note is deleted, or a source is renamed. Cleanup uses currently matching rules. Plain date fields and history are preserved because they may describe other sources
- **Date Format**: Customize date format (uses moment.js format strings)
- **Debounce Delay**: Control processing delay for rapid edits
- **Enable Logging**: Debug logging to browser console

### Value Types
- `date`: Extract and store just the date
- `date_and_title`: Store date, title, and source link
- `append_link`: Add source file link to an array
- `append_unique_link`: Add source link only if not already present
- `replace_link`: Replace field with source link

## Best Practices

### Organizing Rules
- Use clear, descriptive rule names
- Priority controls execution order: lower numbers run first, and later rules may overwrite earlier values
- Test rules with small sets of files first
- Use the validation command to check for conflicts

### Performance
- The plugin debounces file changes to avoid excessive processing
- Use specific source patterns rather than broad wildcards
- Enable logging only when debugging issues

### Data Safety
- The plugin uses Obsidian's atomic frontmatter processing
- Always backup your vault before bulk operations
- Test new rules on a small subset of files first

Configured output properties and their history properties are derived metadata, so their links do not trigger other rules. Configured output properties are also excluded from source date/title extraction. User links in the note body and other frontmatter properties remain inputs.

Repeated automatic events with the same source links, date, and title do not append more entries. Explicit processing commands can still repeat `append_link` entries. History deduplicates identical values from the same source.

Stored ISO dates remain comparable after a format change. Unrecognized existing date strings are preserved; clear or correct them manually before processing.

Requires Obsidian 1.4.4 or newer.

## Development

### Building from Source
```bash
git clone https://github.com/edequalsawesome/awesome-obsidian-backlink-metadata-updater
cd awesome-obsidian-backlink-metadata-updater
npm install
npm run build
npm test
npm run lint
```

### Architecture
- **Main Plugin**: Handles lifecycle and coordination
- **RuleEngine**: Manages rule matching and validation
- **BacklinkProcessor**: Processes files and updates metadata
- **DateExtractor**: Extracts dates from various sources

## Manually Installing the Plugin

- Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/backlink-metadata-updater/`.

## License

ISC License - see LICENSE file for details.

Settings storage failures show a notice. Failed Add/Delete actions restore their still-current rule changes and preserve drafts. Failed option saves leave the active values in memory; change an option again to retry before reloading.
