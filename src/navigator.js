import { Prompt, isCancel } from '@clack/core';
import pc from 'picocolors';
import { readdirSync, statSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import os from 'os';
import prettyBytes from 'pretty-bytes';
import { getDirectoryStats } from './hash.js';

const dirCache = new Map();
const sizeCache = new Map(); // path -> { bytes, files }
const pendingSizes = new Set();

async function fetchDirSize(dirPath, promptInstance) {
  if (sizeCache.has(dirPath) || pendingSizes.has(dirPath)) return;
  pendingSizes.add(dirPath);
  try {
    const stats = await getDirectoryStats(dirPath);
    sizeCache.set(dirPath, { bytes: stats.totalBytes, files: stats.totalFiles });
  } catch (e) {
    sizeCache.set(dirPath, { bytes: -1, files: -1 });
  } finally {
    pendingSizes.delete(dirPath);
    if (promptInstance.state !== 'submit' && promptInstance.state !== 'cancel') {
      if (promptInstance.input && promptInstance.input.emit) {
        promptInstance.input.emit('keypress', undefined, { name: 'clear' });
      }
    }
  }
}

function loadDirectories(currentPath, showHidden = false, showFiles = false) {
  const cacheKey = `${currentPath}|${showHidden}|${showFiles}`;
  if (dirCache.has(cacheKey)) return dirCache.get(cacheKey);

  let directories = [];
  let error = null;
  try {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) continue;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const s = statSync(join(currentPath, entry.name));
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch (e) {
          isDir = false;
          isFile = false;
        }
      }
      if (isDir) {
        directories.push({ name: entry.name, isDir: true, isFile: false });
      } else if (showFiles && isFile) {
        directories.push({ name: entry.name, isDir: false, isFile: true });
        try {
          const fSize = statSync(join(currentPath, entry.name)).size;
          sizeCache.set(join(currentPath, entry.name), { bytes: fSize, files: 1 });
        } catch {
          sizeCache.set(join(currentPath, entry.name), { bytes: -1, files: 0 });
        }
      }
    }
    directories.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  } catch (e) {
    error = e.code === 'EACCES' ? 'Permission Denied' : 'Inaccessible';
  }
  
  const result = { directories, error };
  dirCache.set(cacheKey, result);
  return result;
}

class FileNavigatorPrompt extends Prompt {
  constructor(opts) {
    const allowMultiple = opts.allowMultiple ?? true;
    const maxItems = opts.maxItems || 12;

    super({
      ...opts,
      render() {
        if (this.state === 'submit') {
          const vals = Array.isArray(this.value) ? this.value : [this.value];
          const lines = vals.map(v => `${pc.gray('│')}  ${pc.dim(v)}`).join('\n');
          return `${pc.green('◇')}  ${opts.message}\n${lines}\n`;
        }
        if (this.state === 'cancel') {
          return `${pc.red('■')}  ${opts.message}\n${pc.gray('│')}  ${pc.dim('Cancelled')}\n`;
        }

        const title = `${pc.cyan('◆')}  ${opts.message}\n`;
        const pathLine = `${pc.gray('│')}  Current: ${pc.bold(this.currentPath)}\n`;
        
        let selectedBytes = 0;
        let selectedFiles = 0;
        let isCalculating = false;

        if (allowMultiple && this.selectedPaths.size > 0) {
          for (const sp of this.selectedPaths) {
            if (sizeCache.has(sp)) {
              const stats = sizeCache.get(sp);
              if (stats.bytes >= 0) {
                selectedBytes += stats.bytes;
                selectedFiles += stats.files;
              }
            } else {
              isCalculating = true;
              setTimeout(() => fetchDirSize(sp, this), 0);
            }
          }
        }

        let countBadge = '';
        if (allowMultiple) {
          let sizeStr = '';
          if (this.selectedPaths.size > 0) {
            if (isCalculating) {
              sizeStr = ` - ... calculating`;
            } else {
              sizeStr = ` - ${prettyBytes(selectedBytes)} (${selectedFiles} files)`;
            }
          }
          countBadge = pc.cyan(` [${this.selectedPaths.size} selected${sizeStr}]`);
        }

        let destSpaceStr = '';
        if (opts.availableBytes !== undefined && opts.availableBytes !== Infinity) {
          const remaining = opts.availableBytes - selectedBytes;
          const remainingStr = remaining >= 0 ? pc.green(prettyBytes(remaining)) : pc.red(prettyBytes(remaining));
          destSpaceStr = `${pc.gray('│')}  Destination free: ${pc.bold(prettyBytes(opts.availableBytes))} (Remaining: ${remainingStr})\n`;
        }

        const helpText = '←/Backspace up  → open  Space select  Enter submit  a toggle hidden  f toggle files';
        const helpLine = `${pc.gray('│')}  ${pc.dim(helpText)}${countBadge}\n`;

        const totalItems = this.directories.length + 1; // +1 for [Current Directory]
        if (this.cursor >= totalItems) this.cursor = Math.max(0, totalItems - 1);

        // Calculate stable viewport boundaries
        let startIdx = 0;
        let endIdx = totalItems;
        if (totalItems > maxItems) {
          const half = Math.floor(maxItems / 2);
          startIdx = Math.max(0, this.cursor - half);
          endIdx = Math.min(totalItems, startIdx + maxItems);
          if (endIdx - startIdx < maxItems) {
            startIdx = Math.max(0, endIdx - maxItems);
          }
        }

        // Viewport status header
        const scrollInfo = totalItems > maxItems 
          ? pc.dim(` (Showing ${startIdx + 1}-${endIdx} of ${totalItems})`) 
          : '';
        const divider = `${pc.gray('├')}─${scrollInfo}\n`;

        let list = '';
        if (this.dirError) {
          list += `${pc.gray('│')}  ${pc.red(`✖ ${this.dirError}`)}\n`;
        }

        const visiblePaths = [];

        for (let i = startIdx; i < endIdx; i++) {
          const isHover = this.cursor === i;
          const prefix = isHover ? pc.cyan('❯') : ' ';

          if (i === 0) {
            const isSelected = allowMultiple 
              ? this.selectedPaths.has(this.currentPath)
              : this.selectedSingle === this.currentPath;
            const marker = isSelected ? pc.green('◉') : pc.gray('◯');
            const label = `[Select Current Directory: ${basename(this.currentPath) || this.currentPath}]`;
            list += `${pc.gray('│')}  ${prefix} ${marker} ${isHover ? pc.underline(pc.bold(label)) : pc.bold(label)}\n`;
          } else {
            const entry = this.directories[i - 1];
            const name = entry.name;
            const fullPath = join(this.currentPath, name);
            const isSelected = allowMultiple 
              ? this.selectedPaths.has(fullPath)
              : this.selectedSingle === fullPath;
            const marker = isSelected ? pc.green('◉') : pc.gray('◯');
            const icon = entry.isDir ? '📁' : '📄';
            
            const labelStr = isHover ? pc.underline(name) : name;
            const plainNameLength = name.length;
            const padSpaces = Math.max(1, 45 - plainNameLength);
            
            let sizeDisplay = '';
            if (entry.isDir || entry.isFile) {
              if (sizeCache.has(fullPath)) {
                const stats = sizeCache.get(fullPath);
                const str = stats.bytes >= 0 ? prettyBytes(stats.bytes) : '?';
                sizeDisplay = pc.dim(str.padStart(10));
              } else {
                sizeDisplay = pc.dim('...'.padStart(10));
                if (entry.isDir) {
                  visiblePaths.push(fullPath);
                }
              }
            }
            
            list += `${pc.gray('│')}  ${prefix} ${marker} ${icon} ${labelStr}${' '.repeat(padSpaces)}${sizeDisplay}\n`;
          }
        }

        if (visiblePaths.length > 0) {
          setTimeout(() => {
            for (const p of visiblePaths) {
              fetchDirSize(p, this);
            }
          }, 0);
        }

        return title + pathLine + destSpaceStr + helpLine + divider + list;
      }
    }, false);

    this.allowMultiple = allowMultiple;
    this.showHidden = false;
    this.showFiles = false;
    this.basePath = resolve(opts.basePath || os.homedir());
    this.currentPath = this.basePath;
    this.selectedPaths = new Set();
    this.selectedSingle = null;
    this.cursor = 0;
    this.history = new Map();

    const { directories, error } = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
    this.directories = directories;
    this.dirError = error;

    this.on('key', (key, l) => {
      const len = this.directories.length + 1;
      const keyName = l.name;

      if (keyName === 'up' || key === 'k') {
        this.cursor = this.cursor <= 0 ? 0 : this.cursor - 1;
      } 
      else if (keyName === 'down' || key === 'j') {
        this.cursor = this.cursor >= len - 1 ? len - 1 : this.cursor + 1;
      } 
      else if (keyName === 'left' || key === 'h' || keyName === 'backspace') {
        const parent = dirname(this.currentPath);
        if (parent !== this.currentPath) {
          const currentFolderName = basename(this.currentPath);
          this.history.set(parent, currentFolderName);
          this.currentPath = parent;
          const res = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
          this.directories = res.directories;
          this.dirError = res.error;

          const prevIdx = this.directories.findIndex(e => e.name === currentFolderName);
          this.cursor = prevIdx !== -1 ? prevIdx + 1 : 0;
        }
      } 
      else if (keyName === 'right' || key === 'l') {
        if (this.cursor > 0 && this.directories[this.cursor - 1]) {
          const entry = this.directories[this.cursor - 1];
          if (entry.isDir) {
            const dir = entry.name;
            this.history.set(this.currentPath, dir);
            this.currentPath = join(this.currentPath, dir);
            const res = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
            this.directories = res.directories;
            this.dirError = res.error;
            this.cursor = 0;
          }
        }
      } 
      else if (keyName === 'space') {
        let togglePath = this.currentPath;
        if (this.cursor > 0) {
          togglePath = join(this.currentPath, this.directories[this.cursor - 1].name);
        }
        if (this.allowMultiple) {
          if (this.selectedPaths.has(togglePath)) {
            this.selectedPaths.delete(togglePath);
          } else {
            this.selectedPaths.add(togglePath);
          }
        } else {
          this.selectedSingle = (this.selectedSingle === togglePath) ? null : togglePath;
        }
      } 
      else if (key === 'a' || key === 'A') {
        this.showHidden = !this.showHidden;
        const res = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
        this.directories = res.directories;
        this.dirError = res.error;
        this.cursor = Math.min(this.cursor, this.directories.length);
      }
      else if (key === 'f' || key === 'F') {
        this.showFiles = !this.showFiles;
        const res = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
        this.directories = res.directories;
        this.dirError = res.error;
        this.cursor = Math.min(this.cursor, this.directories.length);
      }
      else if (keyName === 'return' || keyName === 'enter') {
        if (this.allowMultiple) {
          if (this.selectedPaths.size === 0) {
            if (this.cursor > 0 && this.directories[this.cursor - 1]) {
              this.value = [join(this.currentPath, this.directories[this.cursor - 1].name)];
            } else {
              this.value = [this.currentPath];
            }
          } else {
            this.value = Array.from(this.selectedPaths);
          }
        } else {
          if (!this.selectedSingle && this.cursor > 0 && this.directories[this.cursor - 1]) {
            this.value = [join(this.currentPath, this.directories[this.cursor - 1].name)];
          } else if (!this.selectedSingle) {
            this.value = [this.currentPath];
          } else {
            this.value = [this.selectedSingle];
          }
        }
        this.state = 'submit';
      }
    });
  }
}

export async function navigateDirectory(message, basePath = os.homedir(), allowMultiple = false, availableBytes = undefined) {
  const prompt = new FileNavigatorPrompt({ message, basePath, allowMultiple, maxItems: 12, availableBytes });
  const result = await prompt.prompt();
  if (isCancel(result)) {
    console.log(pc.red('Operation cancelled.'));
    process.exit(0);
  }
  return result;
}
