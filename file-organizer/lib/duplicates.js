import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import { walkFiles } from './scanner.js';

/**
 * Calculates SHA-256 via a stream: the file is read in chunks,
 * so even very large files are never loaded into memory in full.
 */
export function calculateHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export class DuplicateFinder extends EventEmitter {
  async find(directory) {
    const files = await walkFiles(directory, {
      onError: (data) => this.emit('file-error', data),
    });
    this.emit('search-start', { directory, total: files.length });

    // Map<hash, Array<{ path, size }>>
    const byHash = new Map();
    let processed = 0;

    for (const filePath of files) {
      processed += 1;
      try {
        const { size } = await fsp.stat(filePath);
        // Empty files all share the same hash but take no space, so skip them
        if (size > 0) {
          const hash = await calculateHash(filePath);
          const group = byHash.get(hash) ?? [];
          group.push({ path: filePath, size });
          byHash.set(hash, group);
        }
      } catch (error) {
        this.emit('file-error', { path: filePath, error, processed, total: files.length });
      }
      this.emit('file-processed', { path: filePath, processed, total: files.length });
    }

    const groups = [];
    for (const [hash, copies] of byHash) {
      if (copies.length > 1) {
        const size = copies[0].size;
        groups.push({
          hash,
          size,
          files: copies.map((copy) => copy.path),
          wastedSpace: size * (copies.length - 1),
        });
      }
    }
    groups.sort((a, b) => b.wastedSpace - a.wastedSpace);

    const result = {
      directory,
      groups,
      totalWasted: groups.reduce((sum, group) => sum + group.wastedSpace, 0),
    };
    this.emit('duplicates-found', result);
    return result;
  }
}
