#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { Scanner } from './lib/scanner.js';
import { DuplicateFinder } from './lib/duplicates.js';
import { Organizer } from './lib/organizer.js';
import { Cleanup } from './lib/cleanup.js';

const SEPARATOR = '━'.repeat(34);
const VALUE_FLAGS = ['output', 'older-than'];
const BOOLEAN_FLAGS = ['confirm', 'help'];
const CLEANUP_PREVIEW_LIMIT = 10;
const TOP_TYPES_LIMIT = 10;

const USAGE = `
Usage: node file-organizer.js <command> <directory> [options]

Commands:
  scan <directory>                          Show statistics about files
  duplicates <directory>                    Find files with identical content (SHA-256)
  organize <source> --output <target>       Copy files into category folders
  cleanup <directory> --older-than <days>   List files older than N days (dry run)
          [--confirm]                       ...and actually delete them

Options:
  --help                                    Show this help
`;

// ─── Helpers ───────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const name = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);

    if (BOOLEAN_FLAGS.includes(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const value = eqIndex === -1 ? rest[(i += 1)] : arg.slice(eqIndex + 1);
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new UsageError(`Option --${name} requires a value`);
      }
      flags[name] = value;
    } else {
      throw new UsageError(`Unknown option: --${name}`);
    }
  }

  return { command, positional, flags };
}

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function drawProgressBar(current, total, width = 20) {
  const percentage = total === 0 ? 1 : current / total;
  const filled = Math.round(percentage * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${bar} ${current}/${total}`;
}

function createProgress(label, suffix = '') {
  let finished = false;
  return {
    update(current, total) {
      if (finished) return;
      if (!process.stdout.isTTY && current < total) return;
      process.stdout.write(`\r${label} ${drawProgressBar(current, total)}${suffix}`);
      if (current >= total) {
        process.stdout.write('\n');
        finished = true;
      }
    },
  };
}

function describeError(error, target) {
  switch (error.code) {
    case 'ENOENT':
      return `Not found: ${target}`;
    case 'EACCES':
    case 'EPERM':
      return `Permission denied: ${target}`;
    case 'ENOTDIR':
      return `Not a directory: ${target}`;
    case 'EISDIR':
      return `Is a directory, expected a file: ${target}`;
    case 'EEXIST':
      return `Already exists: ${target}`;
    case 'EBUSY':
      return `File is busy or locked: ${target}`;
    case 'ENOSPC':
      return `No space left on device while writing: ${target}`;
    case 'EMFILE':
      return `Too many open files while processing: ${target}`;
    default:
      return `Unexpected error (${error.code ?? 'unknown'}) for ${target}: ${error.message}`;
  }
}

/** Collects per-file errors so they don't break the progress bar, and prints them at the end */
function createErrorCollector() {
  const errors = [];
  return {
    add: ({ path: target, error }) => errors.push(describeError(error, target)),
    report() {
      if (errors.length === 0) return;
      console.log(`\n⚠️  ${errors.length} file(s) could not be processed:`);
      for (const message of errors) console.log(`  ❌ ${message}`);
      process.exitCode = 1;
    },
  };
}

/** Display path: Downloads/backup/file.pdf instead of the full absolute path */
function displayPath(root, filePath) {
  return path.join(path.basename(root), path.relative(root, filePath));
}

/**
 * Expands ~ to the home directory. bash/zsh do this themselves,
 * but PowerShell and cmd pass "~/Downloads" to the program literally.
 */
function resolveUserPath(input) {
  if (input === '~' || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(1));
  }
  return path.resolve(input);
}

function requireDirectory(positional, command) {
  if (!positional[0]) {
    throw new UsageError(`Command "${command}" requires a directory path`);
  }
  return resolveUserPath(positional[0]);
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function runScan(directory) {
  const scanner = new Scanner();
  const errors = createErrorCollector();
  const progress = createProgress('Processing...', ' files');

  scanner.on('scan-start', ({ directory: dir, total }) => {
    console.log(`📂 Scanning: ${dir}`);
    if (total === 0) progress.update(0, 0);
  });
  scanner.on('file-found', ({ processed, total }) => progress.update(processed, total));
  scanner.on('file-error', (data) => {
    errors.add(data);
    if (data.processed) progress.update(data.processed, data.total);
  });

  scanner.on('scan-complete', (stats) => {
    console.log('\n📊 Scan Results:');
    console.log(SEPARATOR);
    console.log(`Total files: ${stats.totalFiles}`);
    console.log(`Total size: ${formatSize(stats.totalSize)}`);

    if (stats.totalFiles === 0) return;

    console.log('\nBy File Type:');
    const types = [...stats.byType.entries()].sort((a, b) => b[1].totalSize - a[1].totalSize);
    const shown = types.slice(0, TOP_TYPES_LIMIT);
    const rest = types.slice(TOP_TYPES_LIMIT);
    if (rest.length > 0) {
      shown.push([
        '(other)',
        rest.reduce(
          (acc, [, t]) => ({ count: acc.count + t.count, totalSize: acc.totalSize + t.totalSize }),
          { count: 0, totalSize: 0 },
        ),
      ]);
    }
    const extWidth = Math.max(...shown.map(([ext]) => ext.length)) + 1;
    for (const [ext, { count, totalSize }] of shown) {
      console.log(
        `  ${ext.padEnd(extWidth)} ${String(count).padStart(4)} files  ${formatSize(totalSize).padStart(9)}`,
      );
    }

    console.log('\nFile Age:');
    console.log(`  Last 7 days:    ${stats.byAge.last7Days} files`);
    console.log(`  Last 30 days:   ${stats.byAge.last30Days} files`);
    console.log(`  Older than 90:  ${stats.byAge.olderThan90Days} files`);

    console.log('\nLargest files:');
    const nameWidth = Math.max(...stats.largest.map((f) => f.name.length)) + 2;
    stats.largest.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file.name.padEnd(nameWidth)} ${formatSize(file.size).padStart(9)}`);
    });

    const { oldest } = stats;
    console.log(
      `\nOldest file: ${oldest.name} (modified ${Math.floor(oldest.ageDays)} days ago, ${formatDate(oldest.mtime)})`,
    );
  });

  await scanner.scan(directory);
  errors.report();
}

async function runDuplicates(directory) {
  const finder = new DuplicateFinder();
  const errors = createErrorCollector();
  const progress = createProgress('Calculating hashes...', ' files');

  finder.on('search-start', ({ directory: dir, total }) => {
    console.log(`🔍 Searching for duplicates in: ${dir}`);
    if (total === 0) progress.update(0, 0);
  });
  finder.on('file-processed', ({ processed, total }) => progress.update(processed, total));
  finder.on('file-error', errors.add);

  finder.on('duplicates-found', ({ groups, totalWasted }) => {
    if (groups.length === 0) {
      console.log('\n✅ No duplicates found.');
      return;
    }

    console.log(`\nFound ${groups.length} duplicate groups (${formatSize(totalWasted)} wasted):\n`);
    groups.forEach((group, index) => {
      console.log(SEPARATOR);
      console.log(`Group ${index + 1} (${group.files.length} copies, ${formatSize(group.size)} each):`);
      console.log(`  SHA-256: ${group.hash.slice(0, 12)}...\n`);
      for (const file of group.files) {
        console.log(`  📄 ${displayPath(directory, file)}`);
      }
      console.log(`\n  Wasted space: ${formatSize(group.wastedSpace)}\n`);
    });
    console.log(SEPARATOR);
    console.log(`💾 Total wasted space: ${formatSize(totalWasted)}`);
  });

  await finder.find(directory);
  errors.report();
}

async function runOrganize(sourceDir, targetDir) {
  const organizer = new Organizer();
  const errors = createErrorCollector();
  const progress = createProgress('Copying files...');
  const targetName = path.basename(targetDir);

  organizer.on('organize-start', () => {
    console.log(`📦 Organizing: ${sourceDir}`);
    console.log(`Target: ${targetDir}\n`);
    console.log('Creating folders...');
  });
  organizer.on('folder-created', ({ category }) => console.log(`  ✓ ${category}/`));
  organizer.on('folders-created', ({ total }) => {
    console.log('');
    if (total === 0) progress.update(0, 0);
  });
  organizer.on('copy-complete', ({ processed, total }) => progress.update(processed, total));
  organizer.on('copy-error', (data) => {
    errors.add(data);
    if (data.processed) progress.update(data.processed, data.total);
  });

  organizer.on('organize-complete', ({ summary, copiedFiles, copiedSize }) => {
    console.log('\n✅ Organization complete!\n');
    console.log('Summary:');
    const width = Math.max(...Object.keys(summary).map((c) => c.length)) + 1;
    for (const [category, { count }] of Object.entries(summary)) {
      console.log(
        `  ${`${category}:`.padEnd(width)} ${String(count).padStart(5)} files → ${targetName}/${category}/`,
      );
    }
    console.log(`\nTotal copied: ${copiedFiles} files (${formatSize(copiedSize)})`);
  });

  await organizer.organize(sourceDir, targetDir);
  errors.report();
}

function printCleanupList(directory, files) {
  console.log(SEPARATOR);
  for (const file of files.slice(0, CLEANUP_PREVIEW_LIMIT)) {
    console.log(displayPath(directory, file.path));
    console.log(`  Size: ${formatSize(file.size)}`);
    console.log(`  Modified: ${Math.floor(file.daysOld)} days ago (${formatDate(file.mtime)})\n`);
  }
  if (files.length > CLEANUP_PREVIEW_LIMIT) {
    console.log(`... (${files.length - CLEANUP_PREVIEW_LIMIT} more files)`);
  }
  console.log(SEPARATOR);
}

async function runCleanup(directory, olderThanDays, confirm) {
  const cleanup = new Cleanup();
  const errors = createErrorCollector();
  const progress = createProgress('Deleting...');

  cleanup.on('search-start', ({ directory: dir, olderThanDays: days }) => {
    console.log(`🧹 Cleanup: ${dir}`);
    console.log(`Looking for files older than ${days} days...\n`);
  });
  cleanup.on('file-error', (data) => {
    errors.add(data);
    if (data.processed) progress.update(data.processed, data.total);
  });
  cleanup.on('file-deleted', ({ processed, total }) => progress.update(processed, total));
  cleanup.on('cleanup-complete', ({ deletedFiles, freedSize }) => {
    console.log('\n✅ Cleanup complete!');
    console.log(`Deleted: ${deletedFiles} files (${formatSize(freedSize)} freed)`);
  });

  const { files, totalSize } = await cleanup.findOldFiles(directory, olderThanDays);

  if (files.length === 0) {
    console.log('✅ No files found to delete.');
    errors.report();
    return;
  }

  console.log(`Found ${files.length} files to delete:\n`);
  printCleanupList(directory, files);
  console.log(`\nTotal: ${files.length} files (${formatSize(totalSize)})\n`);

  if (!confirm) {
    console.log('⚠️  DRY RUN MODE: No files were deleted.');
    console.log('To actually delete these files, run with --confirm flag.');
    errors.report();
    return;
  }

  console.log(
    `⚠️  DELETING ${files.length} files (${formatSize(totalSize)}). This action cannot be undone!\n`,
  );
  await cleanup.deleteFiles(files);
  errors.report();
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === '--help' || flags.help) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'scan':
      return runScan(requireDirectory(positional, command));

    case 'duplicates':
      return runDuplicates(requireDirectory(positional, command));

    case 'organize': {
      const sourceDir = requireDirectory(positional, command);
      if (!flags.output) {
        throw new UsageError('Command "organize" requires --output <target directory>');
      }
      return runOrganize(sourceDir, resolveUserPath(flags.output));
    }

    case 'cleanup': {
      const directory = requireDirectory(positional, command);
      const days = Number(flags['older-than']);
      if (flags['older-than'] === undefined) {
        throw new UsageError('Command "cleanup" requires --older-than <days>');
      }
      if (!Number.isFinite(days) || days < 0) {
        throw new UsageError(`--older-than must be a non-negative number, got "${flags['older-than']}"`);
      }
      return runCleanup(directory, days, Boolean(flags.confirm));
    }

    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`❌ Error: ${error.message}`);
    console.error(USAGE);
  } else if (error.code === 'ENOENT') {
    console.error(`\n❌ Error: Directory not found: ${error.path}`);
  } else if (error.code === 'EACCES' || error.code === 'EPERM') {
    console.error(`\n❌ Error: Permission denied: ${error.path}`);
  } else if (error.code === 'ENOTDIR') {
    console.error(`\n❌ Error: Not a directory: ${error.path}`);
  } else if (error.code === 'ENOSPC') {
    console.error(`\n❌ Error: No space left on device: ${error.path}`);
  } else {
    console.error(`\n❌ Unexpected error: ${error.message}`);
  }
  process.exit(1);
}
