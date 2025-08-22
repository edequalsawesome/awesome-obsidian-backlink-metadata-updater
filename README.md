# Backlink Metadata Updater

An Obsidian plugin that automatically updates note metadata based on backlinks. When you mention a note in your daily notes or other contexts, the linked note's frontmatter properties are automatically updated with relevant metadata.

## Features

### Core Functionality
- **Automatic Updates**: Real-time metadata updates when files are modified
- **Configurable Rules**: Define custom rules for different note types and contexts
- **Smart Date Extraction**: Automatically extracts dates from daily notes, filenames, and frontmatter
- **Flexible Value Types**: Support for dates, links, titles, and custom values
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
- **Update on Delete**: Clean up metadata when links are removed
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
- Set appropriate priorities for conflicting rules
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

## Development

### Building from Source
```bash
git clone <repository>
cd awesome-obsidian-meta-updater
npm install
npm run build
```

### Architecture
- **Main Plugin**: Handles lifecycle and coordination
- **RuleEngine**: Manages rule matching and validation
- **BacklinkProcessor**: Processes files and updates metadata
- **DateExtractor**: Extracts dates from various sources

## Manually Installing the Plugin

- Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/backlink-metadata-updater/`.

## License

MIT License - see LICENSE file for details.
