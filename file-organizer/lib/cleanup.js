import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { walkFiles, getAgeInDays } from './scanner.js';

export class Cleanup extends EventEmitter {
  /** Finds files last modified more than olderThanDays days ago */
  async findOldFiles(directory, olderThanDays) {
    const files = await walkFiles(directory, {
      onError: (data) => this.emit('file-error', data),
    });
    this.emit('search-start', { directory, olderThanDays, total: files.length });

    const now = Date.now();
    const oldFiles = [];

    for (const filePath of files) {
      try {
        const stats = await fs.stat(filePath);
        const daysOld = getAgeInDays(stats.mtime, now);

        if (daysOld > olderThanDays) {
          const file = {
            path: filePath,
            name: path.basename(filePath),
            size: stats.size,
            mtime: stats.mtime,
            daysOld,
          };
          oldFiles.push(file);
          this.emit('file-found', file);
        }
      } catch (error) {
        this.emit('file-error', { path: filePath, error });
      }
    }

    oldFiles.sort((a, b) => b.daysOld - a.daysOld);
    const result = {
      directory,
      olderThanDays,
      files: oldFiles,
      totalSize: oldFiles.reduce((sum, file) => sum + file.size, 0),
    };
    this.emit('search-complete', result);
    return result;
  }

  /** Deletes the given files with fs.unlink() */
  async deleteFiles(files) {
    this.emit('delete-start', { total: files.length });

    let deletedFiles = 0;
    let freedSize = 0;
    let errors = 0;
    let processed = 0;

    for (const file of files) {
      processed += 1;
      try {
        await fs.unlink(file.path);
        deletedFiles += 1;
        freedSize += file.size;
        this.emit('file-deleted', { ...file, processed, total: files.length });
      } catch (error) {
        errors += 1;
        this.emit('file-error', { path: file.path, error, processed, total: files.length });
      }
    }

    const result = { deletedFiles, freedSize, errors };
    this.emit('cleanup-complete', result);
    return result;
  }
}
