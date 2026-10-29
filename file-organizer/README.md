# 🗂️ file-organizer

A Node.js CLI tool that brings order to messy directories like `Downloads`:

- **scan** — file statistics: count, size, types, age, largest and oldest files
- **duplicates** — finds files with identical content via SHA-256 hashes
- **organize** — copies files into category folders (Documents, Images, Archives, Code, Videos, Other)
- **cleanup** — finds and deletes files older than N days, with a dry-run preview

No dependencies — only Node.js built-ins (`fs`, `path`, `crypto`, `events`, `stream`).

## Installation

Requires **Node.js 18+**.

```bash
git clone https://github.com/VolodymyrKh/goit-node-hw-01.git
cd goit-node-hw-01/file-organizer
```

No `npm install` needed.

## Usage

```bash
node file-organizer.js <command> <directory> [options]
node file-organizer.js --help
```

Each command also has an npm script; pass arguments after `--`:

```bash
npm run scan -- ~/Downloads
npm run organize -- ~/Downloads --output ~/Organized
```

`~` is expanded to the home directory in any shell, including PowerShell and cmd.
Quote paths that contain spaces.

## Commands

### `scan <directory>`

Recursively walks the directory and reports totals, a breakdown by extension (top 10 by size,
the rest grouped as `(other)`), file age (modified in the last 7 / 30 days, older than 90 days),
the 3 largest files and the oldest file.

```bash
node file-organizer.js scan ~/Downloads
```

```
📂 Scanning: /Users/student/Downloads
Processing... ████████████████████ 17/17 files

📊 Scan Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total files: 17
Total size: 25.9 MB

By File Type:
  .mp4         2 files    24.0 MB
  .png         3 files     1.0 MB
  .pdf         4 files   878.9 KB

File Age:
  Last 7 days:    14 files
  Last 30 days:   14 files
  Older than 90:  2 files

Largest files:
  1. video_lecture.mp4          12.0 MB
  2. ancient_screenshot.png    781.3 KB
  3. lecture.pdf               293.0 KB

Oldest file: ancient_screenshot.png (modified 515 days ago, 2025-06-01)
```

### `duplicates <directory>`

Hashes every file with SHA-256 (read in chunks via `fs.createReadStream()`, so large files never
load fully into memory) and groups files with the same hash.
Wasted space = file size × (copies − 1). Empty files are skipped. Nothing is deleted.

```bash
node file-organizer.js duplicates ~/Downloads
```

```
Found 2 duplicate groups (12.6 MB wasted):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Group 1 (2 copies, 12.0 MB each):
  SHA-256: 00bdb9068ce6...

  📄 Downloads/backup/video_lecture.mp4
  📄 Downloads/video_lecture.mp4

  Wasted space: 12.0 MB
...
💾 Total wasted space: 12.6 MB
```

### `organize <source> --output <target>`

| Argument            | Description                                       |
| ------------------- | ------------------------------------------------- |
| `<source>`          | Directory to copy files from (recursively)        |
| `--output <target>` | Destination; created if missing. `--output=<target>` also works |

Copies files into category folders by extension (case-insensitive). **Originals are left untouched.**

| Category    | Extensions                                         |
| ----------- | -------------------------------------------------- |
| `Documents` | `.pdf .docx .doc .txt .md .xlsx .pptx`             |
| `Images`    | `.png .jpg .jpeg .gif .svg .webp .bmp`             |
| `Archives`  | `.zip .rar .tar .gz .7z`                           |
| `Code`      | `.js .py .java .cpp .html .css .json`              |
| `Videos`    | `.mp4 .avi .mkv .mov .webm`                        |
| `Other`     | everything else, including files with no extension |

- Files **≥ 10 MB** are copied with streams (`pipeline()`), smaller ones with `fs.copyFile()`.
- Existing files are never overwritten: name clashes become `file(1).pdf`, `file(2).pdf`, …
- If the target is inside the source, it is excluded from the scan.

```bash
node file-organizer.js organize ~/Downloads --output ~/Organized
```

```
Creating folders...
  ✓ Documents/
  ...
Copying files... ████████████████████ 17/17

✅ Organization complete!

Summary:
  Documents:     7 files → Organized/Documents/
  Images:        3 files → Organized/Images/
  ...
Total copied: 17 files (25.9 MB)
```

### `cleanup <directory> --older-than <days> [--confirm]`

| Argument              | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `<directory>`         | Directory to search (recursively)                         |
| `--older-than <days>` | Required. Age threshold by modification time (≥ 0)        |
| `--confirm`           | Actually delete the files. Without it — dry run only      |

Lists matching files oldest first (first 10 in detail, then `... (N more files)`).
With `--confirm` they are removed via `fs.unlink()` — **permanently, not to the recycle bin**.

```bash
node file-organizer.js cleanup ~/Downloads --older-than 90            # preview
node file-organizer.js cleanup ~/Downloads --older-than 90 --confirm  # delete
```

```
Found 2 files to delete:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Downloads/ancient_screenshot.png
  Size: 781.3 KB
  Modified: 515 days ago (2025-06-01)
...
Total: 2 files (781.3 KB)

⚠️  DRY RUN MODE: No files were deleted.
To actually delete these files, run with --confirm flag.
```

## Project structure

```
file-organizer/
├── package.json        # "type": "module", npm scripts
├── .gitignore
├── README.md
├── file-organizer.js   # entry point: argument parsing, console output, progress bars
└── lib/
    ├── scanner.js      # Scanner + shared recursive walker walkFiles()
    ├── duplicates.js   # DuplicateFinder + streamed calculateHash()
    ├── organizer.js    # Organizer, category map, copying, name-clash handling
    └── cleanup.js      # Cleanup: finding and deleting old files
```

## Architecture

Each command is a class extending `EventEmitter`. The classes contain only the logic and never
print anything; `file-organizer.js` subscribes to their events to draw progress bars and reports.

| Class             | Main events                                              |
| ----------------- | -------------------------------------------------------- |
| `Scanner`         | `scan-start`, `file-found`, `scan-complete`              |
| `DuplicateFinder` | `search-start`, `file-processed`, `duplicates-found`     |
| `Organizer`       | `folder-created`, `copy-start`, `copy-complete`, `copy-error` |
| `Cleanup`         | `file-found`, `file-deleted`, `cleanup-complete`         |

## Error handling

All file operations are wrapped in `try...catch` with specific messages for `ENOENT`, `EACCES`/`EPERM`,
`ENOTDIR`, `EISDIR`, `EEXIST`, `EBUSY`, `ENOSPC` and `EMFILE`.

- Fatal errors (missing or inaccessible directory, invalid arguments) stop the program with exit code `1`.
- Per-file errors (locked file, unreadable subfolder) don't stop processing; they are listed at the end
  and the exit code is `1`.

```
$ node file-organizer.js scan /no/such/dir
❌ Error: Directory not found: /no/such/dir
```
