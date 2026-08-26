import * as p from '@clack/prompts';
import { Listr } from 'listr2';
import pc from 'picocolors';
import boxen from 'boxen';
import { resolve, sep, isAbsolute, basename, join, relative } from 'path';
import { statSync, accessSync, constants, mkdirSync } from 'fs';
import { executeTransfer } from './rsync.js';
import { hashDirectory, compareManifests, shouldHashSequentially } from './hash.js';

export function sanitizeSources(rawSources) {
  const resolved = Array.from(new Set(rawSources.map(s => resolve(s))));
  resolved.sort((a, b) => a.length - b.length);

  const pruned = [];
  for (const src of resolved) {
    const isNested = pruned.some(parent => 
      parent === '/' ? true : src.startsWith(parent + sep)
    );
    if (!isNested) {
      pruned.push(src);
    }
  }
  return pruned;
}

export async function runWizard(options) {
  p.intro(pc.bgCyan(pc.black(' rsynxiety - Verified File Transfer ')));

  let { sources: rawSources, destination, canary, skipHash } = options;
  const { navigateDirectory } = await import('./navigator.js');

  async function getPath(label, allowMultiple = false) {
    const method = await p.select({
      message: `${label} - How would you like to select the path?`,
      options: [
        { value: 'browse', label: 'Browse interactively (Arrow keys)' },
        { value: 'type', label: 'Type or paste absolute path' }
      ]
    });
    
    if (p.isCancel(method)) {
      p.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (method === 'browse') {
      return await navigateDirectory(`Navigate to your ${label.toLowerCase()}`, undefined, allowMultiple);
    } else {
      const paths = [];
      while (true) {
        const typed = await p.text({
          message: `Type ${label.toLowerCase()} path${allowMultiple ? ' (or leave blank to finish)' : ''}:`,
          validate: (value) => {
            if (!allowMultiple && !value) return 'Please enter a path.';
            return undefined;
          },
        });
        if (p.isCancel(typed)) {
          p.cancel('Operation cancelled.');
          process.exit(0);
        }
        if (!typed) break;
        let finalTyped = typed;
        if (finalTyped.startsWith('~')) {
          const os = await import('os');
          finalTyped = finalTyped.replace(/^~/, os.homedir());
        }
        paths.push(finalTyped);
        if (!allowMultiple) break;
      }
      return paths;
    }
  }

  if (!rawSources || rawSources.length === 0) {
    rawSources = await getPath('Source directories', true);
  }
  
  if (!destination) {
    const destArr = await getPath('Destination directory', false);
    destination = destArr[0];
  }
  destination = resolve(destination);

  const sources = sanitizeSources(rawSources);

  const tasks = new Listr([
    {
      title: 'Validation',
      task: async (ctx, task) => {
        try {
          const { execa } = await import('execa');
          await execa('rsync', ['--version']);
          await execa('xxh128sum', ['--help']).catch(e => {
            if (e.exitCode === 127) throw e;
          });
        } catch (e) {
          throw new Error('Install "rsync" and "xxhash" (for xxh128sum).');
        }

        if (destination === '/' || basename(destination).length === 0) {
          throw new Error(`Cannot use root directory (/) as destination.`);
        }

        for (const source of sources) {
          if (source === '/' || basename(source).length === 0) {
            throw new Error(`Cannot transfer the root directory (/). Please select specific subdirectories.`);
          }
          
          try {
            const srcStat = statSync(source);
            if (!srcStat.isDirectory()) throw new Error(`Source path '${source}' exists but is not a directory.`);
          } catch (e) {
            throw new Error(`Source directory inaccessible: ${e.message || e}`);
          }

          if (source === destination) {
            throw new Error(`Source and destination paths cannot be identical (${source}).`);
          }

          const rel = relative(source, destination);
          if (!rel.startsWith('..') && !isAbsolute(rel) && rel !== '') {
            throw new Error(`Infinite recursion risk: Destination (${destination}) is inside source (${source}).`);
          }

          const destToSrc = relative(destination, source);
          if (!destToSrc.startsWith('..') && !isAbsolute(destToSrc) && destToSrc !== '') {
            throw new Error(`Self-nesting risk: Source (${source}) is inside Destination (${destination}).`);
          }

          try {
            accessSync(source, constants.R_OK);
          } catch (e) {
            throw new Error(`Permission denied: Cannot read from source directory '${source}'.`);
          }
        }

        const seen = new Map();
        for (const s of sources) {
          const norm = basename(s).normalize('NFC').toLowerCase();
          if (seen.has(norm)) {
            throw new Error(`Basename collision detected between '${seen.get(norm)}' and '${s}' (considering case and Unicode normalization). Rsync would merge them together in the destination.`);
          }
          seen.set(norm, s);
        }

        if (canary) {
          if (isAbsolute(canary)) {
            throw new Error(`Canary path '${canary}' must be a relative filename, not absolute.`);
          }
          let current = destination;
          let foundPath = null;
          const { dirname } = await import('path');

          while (true) {
            const candidate = join(current, canary);
            try {
              accessSync(candidate, constants.R_OK);
              foundPath = candidate;
              break;
            } catch {
              const parent = dirname(current);
              if (parent === current) break; // Reached root /
              current = parent;
            }
          }

          if (!foundPath) {
            throw new Error(`Canary/Sentinel file '${canary}' not found in destination '${destination}' or any parent mount point. Aborting to prevent accidental root/wrong-mount pollution.`);
          }
        }

        try {
          mkdirSync(destination, { recursive: true });
        } catch (e) {
          throw new Error(`Failed to create destination directory '${destination}'. Error: ${e.code} - ${e.message}`);
        }

        try {
          accessSync(destination, constants.W_OK);
        } catch (e) {
          throw new Error(`Permission denied: Cannot write to destination directory '${destination}'.`);
        }

        task.title = 'Validation (Passed)';
      }
    },
    {
      title: `Transferring data via rsync (${sources.length} sources)`,
      task: async (ctx, task) => {
        const stats = await executeTransfer(sources, destination, (progressLine) => {
           task.output = progressLine;
        });
        ctx.stats = stats;
        task.title = 'Transfer complete';
      }
    },
    {
      title: 'Flushing OS caches to physical media',
      task: async (ctx, task) => {
        const { execa } = await import('execa');
        await execa('sync');
        task.title = 'Caches flushed to physical media';
      }
    },
    {
      title: 'Verification (xxHash)',
      skip: () => skipHash,
      task: (ctx, task) => {
        return task.newListr(
          sources.map(source => ({
            title: `Verifying ${basename(source)}`,
            task: (subCtx, subTask) => {
              const targetDir = join(destination, basename(source));
              const sequential = shouldHashSequentially(source, targetDir);

              return subTask.newListr([
                {
                  title: 'Comparing hashes',
                  task: (auditCtx, auditTask) => {
                    return auditTask.newListr([
                      {
                        title: 'Hashing source',
                        task: async (tCtx, tTask) => {
                          tCtx.sourceManifest = await hashDirectory(source, (p) => {
                            if (p.status === 'scanning') {
                              tTask.output = 'Scanning directory to calculate ETA...';
                            } else if (p.status === 'hashing') {
                              const safeFile = p.currentFile.replace(/[\r\n\x00-\x1f]/g, ' ');
                              tTask.output = `${p.percent}% | ETA: ${p.eta} | ${p.speed} | ${p.processedFiles}/${p.totalFiles} files | ${safeFile.slice(-40)}`;
                            }
                          }, canary);
                        }
                      },
                      {
                        title: 'Hashing destination',
                        task: async (tCtx, tTask) => {
                          tCtx.destManifest = await hashDirectory(targetDir, (p) => {
                            if (p.status === 'scanning') {
                              tTask.output = 'Scanning directory to calculate ETA...';
                            } else if (p.status === 'hashing') {
                              const safeFile = p.currentFile.replace(/[\r\n\x00-\x1f]/g, ' ');
                              tTask.output = `${p.percent}% | ETA: ${p.eta} | ${p.speed} | ${p.processedFiles}/${p.totalFiles} files | ${safeFile.slice(-40)}`;
                            }
                          }, canary);
                        }
                      }
                    ], { concurrent: !sequential });
                  }
                },
                {
                  title: 'Comparing manifests',
                  task: async (auditCtx, auditTask) => {
                    if (auditCtx.sourceManifest.size === 0 && auditCtx.destManifest.size === 0) {
                       return;
                    }
                    const errors = compareManifests(auditCtx.sourceManifest, auditCtx.destManifest);
                    if (errors.length > 0) {
                      throw new Error(`VERIFICATION FAILED for ${basename(source)}!\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n...and ${errors.length - 5} more mismatches.` : ''}`);
                    }
                    auditTask.title = `Hashes match (${auditCtx.sourceManifest.size} files verified)`;
                  }
                }
              ], { concurrent: false });
            }
          })), 
          { concurrent: false }
        );
      }
    }
  ], { concurrent: false, rendererOptions: { collapseSubtasks: false } });

  try {
    await tasks.run();
    p.outro('All done!');
    
    console.log(boxen(
      `${pc.green('✔ Transfer and verification complete.')}\n\n` +
      `• Sources:\n${sources.map(s => `  - ${pc.bold(s)}`).join('\n')}\n` +
      `• Dest:   ${pc.bold(destination)}\n`,
      { padding: 1, margin: 1, borderStyle: 'round', borderColor: 'green' }
    ));
  } catch (e) {
    p.outro(pc.red(`Operation failed: ${e.message || 'Unknown error'}`));
    process.exit(1);
  }
}
