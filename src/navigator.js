import { Prompt, isCancel } from '@clack/core';
import pc from 'picocolors';
import { readdirSync, statSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import os from 'os';

const dirCache = new Map();

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
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(join(currentPath, entry.name)).isDirectory();
        } catch(e) {
          isDir = false;
        }
      }
      if (isDir) {
        directories.push({ name: entry.name, isDir: true });
      } else if (showFiles && entry.isFile()) {
        directories.push({ name: entry.name, isDir: false });
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
        
        const countBadge = allowMultiple 
          ? pc.cyan(` [${this.selectedPaths.size} selected]`)
          : '';
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
            list += `${pc.gray('│')}  ${prefix} ${marker} ${icon} ${isHover ? pc.underline(name) : name}\n`;
          }
        }

        return title + pathLine + helpLine + divider + list;
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
    this.history = new Map(); // stores last active child directory per parent path

    const { directories, error } = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
    this.directories = directories;
    this.dirError = error;

    this.on('key', (key, l) => {
      const len = this.directories.length + 1;
      const keyName = l.name;

      // 1. Up Navigation (Up arrow, 'k')
      if (keyName === 'up' || key === 'k') {
        this.cursor = this.cursor <= 0 ? 0 : this.cursor - 1;
      } 
      // 2. Down Navigation (Down arrow, 'j')
      else if (keyName === 'down' || key === 'j') {
        this.cursor = this.cursor >= len - 1 ? len - 1 : this.cursor + 1;
      } 
      // 3. Parent Navigation (Left arrow, 'h', Backspace)
      else if (keyName === 'left' || key === 'h' || keyName === 'backspace') {
        const parent = dirname(this.currentPath);
        if (parent !== this.currentPath) {
          const currentFolderName = basename(this.currentPath);
          this.history.set(parent, currentFolderName);
          this.currentPath = parent;
          const res = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
          this.directories = res.directories;
          this.dirError = res.error;

          // Restore cursor to previous folder
          const prevIdx = this.directories.findIndex(e => e.name === currentFolderName);
          this.cursor = prevIdx !== -1 ? prevIdx + 1 : 0;
        }
      } 
      // 4. Drill Down (Right arrow, 'l')
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
      // 5. Toggle Selection (Space)
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
      // 6. Toggle Hidden Files ('a')
      else if (key === 'a' || key === 'A') {
        this.showHidden = !this.showHidden;
        const res = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
        this.directories = res.directories;
        this.dirError = res.error;
        this.cursor = Math.min(this.cursor, this.directories.length);
      }
      // Toggle File View ('f')
      else if (key === 'f' || key === 'F') {
        this.showFiles = !this.showFiles;
        const res = loadDirectories(this.currentPath, this.showHidden, this.showFiles);
        this.directories = res.directories;
        this.dirError = res.error;
        this.cursor = Math.min(this.cursor, this.directories.length);
      }
      // 7. Submit / Select (Enter/Return)
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

export async function navigateDirectory(message, basePath = os.homedir(), allowMultiple = false) {
  const prompt = new FileNavigatorPrompt({ message, basePath, allowMultiple, maxItems: 12 });
  const result = await prompt.prompt();
  if (isCancel(result)) {
    console.log(pc.red('Operation cancelled.'));
    process.exit(0);
  }
  return result;
}
