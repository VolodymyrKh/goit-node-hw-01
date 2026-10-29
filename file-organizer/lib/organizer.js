import { EventEmitter } from 'events';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { walkFiles } from './scanner.js';

export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10 MB

export const categories = {
  Documents: ['.pdf', '.docx', '.doc', '.txt', '.md', '.xlsx', '.pptx'],
  Images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'],
  Archives: ['.zip', '.rar', '.tar', '.gz', '.7z'],
  Code: ['.js', '.py', '.java', '.cpp', '.html', '.css', '.json'],
  Videos: ['.mp4', '.avi', '.mkv', '.mov', '.webm'],
  Other: [],
};

export function getCategory(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const match = Object.entries(categories).find(([, extensions]) =>
    extensions.includes(extension),
  );
  return match ? match[0] : 'Other';
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** file.pdf → file(1).pdf → file(2).pdf ... — first free name in the directory */
export async function getAvailablePath(directory, fileName) {
  const { name, ext } = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  let counter = 0;

  while (await exists(candidate)) {
    counter += 1;
    candidate = path.join(directory, `${name}(${counter})${ext}`);
  }
  return candidate;
}

export class Organizer extends EventEmitter {
  async organize(sourceDir, targetDir) {
    // The target may be inside the source directory — don't scan it
    const files = await walkFiles(sourceDir, {
      exclude: [targetDir],
      onError: (data) => this.emit('copy-error', data),
    });
    this.emit('organize-start', { sourceDir, targetDir, total: files.length });

    for (const category of Object.keys(categories)) {
      const categoryDir = path.join(targetDir, category);
      await fsp.mkdir(categoryDir, { recursive: true });
      this.emit('folder-created', { category, path: categoryDir });
    }
    this.emit('folders-created', { targetDir, total: files.length });

    const summary = Object.fromEntries(
      Object.keys(categories).map((category) => [category, { count: 0, totalSize: 0 }]),
    );
    let processed = 0;
    let copiedFiles = 0;
    let copiedSize = 0;
    let errors = 0;

    for (const sourcePath of files) {
      processed += 1;
      const category = getCategory(sourcePath);
      this.emit('copy-start', { source: sourcePath, category, processed, total: files.length });

      try {
        const { size } = await fsp.stat(sourcePath);
        const targetPath = await this.#copy(sourcePath, path.join(targetDir, category), size);

        summary[category].count += 1;
        summary[category].totalSize += size;
        copiedFiles += 1;
        copiedSize += size;
        this.emit('copy-complete', {
          source: sourcePath,
          target: targetPath,
          category,
          size,
          processed,
          total: files.length,
        });
      } catch (error) {
        errors += 1;
        this.emit('copy-error', { path: sourcePath, error, processed, total: files.length });
      }
    }

    const result = { sourceDir, targetDir, summary, copiedFiles, copiedSize, errors };
    this.emit('organize-complete', result);
    return result;
  }

  async #copy(sourcePath, categoryDir, size) {
    const targetPath = await getAvailablePath(categoryDir, path.basename(sourcePath));

    // EXCL / 'wx' flags guarantee an existing file is never overwritten
    if (size >= LARGE_FILE_THRESHOLD) {
      await pipeline(
        fs.createReadStream(sourcePath),
        fs.createWriteStream(targetPath, { flags: 'wx' }),
      );
    } else {
      await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
    return targetPath;
  }
}
