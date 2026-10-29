import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

const DAY_MS = 1000 * 60 * 60 * 24;

export async function walkFiles(directory, { exclude = [], onError = () => {} } = {}) {
  const excluded = exclude.map((dir) => path.resolve(dir));
  const files = [];

  async function walk(dir, isRoot) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isRoot) throw error;
      onError({ path: dir, error });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.includes(path.resolve(fullPath))) {
          await walk(fullPath, false);
        }
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(directory, true);
  return files;
}

export function getAgeInDays(mtime, now = Date.now()) {
  return (now - mtime.getTime()) / DAY_MS;
}

export class Scanner extends EventEmitter {
  async scan(directory) {
    const files = await walkFiles(directory, {
      onError: (data) => this.emit('file-error', data),
    });
    this.emit('scan-start', { directory, total: files.length });

    const now = Date.now();
    const statistics = {
      directory,
      totalFiles: 0,
      totalSize: 0,
      byType: new Map(),
      byAge: { last7Days: 0, last30Days: 0, olderThan90Days: 0 },
      largest: [],
      oldest: null,
      errors: 0,
    };

    let processed = 0;
    for (const filePath of files) {
      processed += 1;
      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch (error) {
        statistics.errors += 1;
        this.emit('file-error', { path: filePath, error, processed, total: files.length });
        continue;
      }

      const fileData = {
        path: filePath,
        name: path.basename(filePath),
        extension: path.extname(filePath).toLowerCase() || '(no ext)',
        size: stats.size,
        mtime: stats.mtime,
        ageDays: getAgeInDays(stats.mtime, now),
      };

      this.#collect(statistics, fileData);
      this.emit('file-found', { ...fileData, processed, total: files.length });
    }

    statistics.largest.sort((a, b) => b.size - a.size);
    this.emit('scan-complete', statistics);
    return statistics;
  }

  #collect(statistics, file) {
    statistics.totalFiles += 1;
    statistics.totalSize += file.size;

    const type = statistics.byType.get(file.extension) ?? { count: 0, totalSize: 0 };
    type.count += 1;
    type.totalSize += file.size;
    statistics.byType.set(file.extension, type);

    if (file.ageDays <= 7) statistics.byAge.last7Days += 1;
    if (file.ageDays <= 30) statistics.byAge.last30Days += 1;
    if (file.ageDays > 90) statistics.byAge.olderThan90Days += 1;

    // Keep only the top 3 so we never sort the whole file list
    statistics.largest.push(file);
    if (statistics.largest.length > 3) {
      statistics.largest.sort((a, b) => b.size - a.size);
      statistics.largest.length = 3;
    }

    if (!statistics.oldest || file.mtime < statistics.oldest.mtime) {
      statistics.oldest = file;
    }
  }
}
