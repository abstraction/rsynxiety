import * as p from '@clack/prompts';
import { Listr } from 'listr2';
import pc from 'picocolors';
import boxen from 'boxen';
import { resolve, sep, isAbsolute, basename, join, relative } from 'path';
import { statSync, accessSync, constants, mkdirSync } from 'fs';
import { executeTransfer } from './rsync.js';
import { getDirectoryStats, hashDirectory, compareManifests, shouldHashSequentially } from './hash.js';

function formatDuration(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / 1000 / 60) % 60);
  const h = Math.floor(ms / 1000 / 3600);
  let str = '';
  if (h > 0) str += `${h}h `;
  if (m > 0) str += `${m}m `;
  str += `${s}s`;
  return str.trim() || '0s';
}

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

async function computeSelectionSummary(sources, destination, canary) {
  const spinner = p.spinner();
  spinner.start('Calculating selection size...');

  const statsResults = await Promise.all(
    sources.map(src => getDirectoryStats(src, canary))
  );
  const totalBytes = statsResults.reduce((sum, s) => sum + s.totalBytes, 0);
  const totalFiles = statsResults.reduce((sum, s) => sum + s.totalFiles, 0);

  const { execa } = await import('execa');
  const { dirname } = await import('path');
  let availableBytes = Infinity;
  
  let current = destination;
  while (true) {
    try {
      const { stdout } = await execa('df', ['--output=avail', '--block-size=1', current]);
      availableBytes = parseInt(stdout.trim().split('\n').pop(), 10);
      break;
    } catch (e) {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  spinner.stop('Selection size calculated.');

  const { default: prettyBytes } = await import('pretty-bytes');

  console.log(boxen(
    `${pc.bold('Selection:')} ${sources.length} source${sources.length === 1 ? '' : 's'} · ${prettyBytes(totalBytes)} · ${totalFiles} files\n` +
    `${pc.bold('Destination free:')} ${availableBytes !== Infinity ? prettyBytes(availableBytes) : 'Unknown'}\n` +
    `${pc.bold('After transfer:')} ${availableBytes !== Infinity ? prettyBytes(availableBytes - totalBytes) : 'Unknown'} remaining`,
    { padding: 1, margin: { bottom: 1 }, borderStyle: 'round', borderColor: (availableBytes !== Infinity && totalBytes > availableBytes) ? 'red' : 'cyan' }
  ));

  if (availableBytes !== Infinity && totalBytes > availableBytes) {
    p.cancel(`Not enough space. Need ${prettyBytes(totalBytes - availableBytes)} more.`);
    process.exit(1);
  }

  if (availableBytes !== Infinity && totalBytes > availableBytes * 0.8) {
    const proceed = await p.confirm({
      message: `Transfer will use ${Math.round((totalBytes / availableBytes) * 100)}% of remaining space. Continue?`,
      initialValue: true
    });
    if (!proceed || p.isCancel(proceed)) {
      p.cancel('Operation cancelled.');
      process.exit(0);
    }
  }

  return { totalBytes, totalFiles, availableBytes };
}

export async function runWizard(options) {
  p.intro(pc.bgCyan(pc.black(' rsynxiety - Verified File Transfer ')));

  let { sources: rawSources, destination, canary, skipHash, dryRun } = options;
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
    rawSources = await getPath('Sources', true);
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
          
          let srcStat;
          try {
            srcStat = statSync(source);
          } catch (e) {
            throw new Error(`Source inaccessible: ${e.message || e}`);
          }

          if (source === destination) {
            throw new Error(`Source and destination paths cannot be identical (${source}).`);
          }

          const rel = relative(source, destination);
          if (!rel.startsWith('..') && !isAbsolute(rel) && rel !== '') {
            throw new Error(`Infinite recursion risk: Destination (${destination}) is inside source (${source}).`);
          }

          const destToSrc = relative(destination, source);
          if (srcStat.isDirectory() && !destToSrc.startsWith('..') && !isAbsolute(destToSrc) && destToSrc !== '') {
            throw new Error(`Self-nesting risk: Source (${source}) is inside Destination (${destination}).`);
          }

          try {
            accessSync(source, constants.R_OK);
          } catch (e) {
            throw new Error(`Permission denied: Cannot read from source '${source}'.`);
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
          const destStat = statSync(destination);
          if (!destStat.isDirectory()) {
            throw new Error(`Destination path '${destination}' exists but is not a directory.`);
          }
        } catch (e) {
          if (e.message.includes('exists but is not a directory')) throw e;
          if (e.code !== 'ENOENT') {
            throw new Error(`Destination directory inaccessible: ${e.message || e}`);
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
    }
  ], { concurrent: false, rendererOptions: { collapseSubtasks: false } });

  try {
    // First run validation
    await tasks.run();
    
    // Then calculate summary
    const statsInfo = await computeSelectionSummary(sources, destination, canary);
    
    // Then run the rest of the tasks
    const transferTasks = new Listr([
      {
        title: 'Checking for previous partial transfers',
        skip: () => dryRun,
        task: async (ctx, task) => {
          const partials = [];
          for (const source of sources) {
            const partialDir = join(destination, basename(source), '.rsync-partial');
            try {
              const s = statSync(partialDir);
              if (s.isDirectory()) partials.push(basename(source));
            } catch {}
          }
          if (partials.length > 0) {
            task.title = `Resuming: found partial data for ${partials.length} source${partials.length > 1 ? 's' : ''}`;
          } else {
            task.title = 'No previous partial transfers found';
          }
        }
      },
      {
        title: dryRun ? `Previewing transfer via rsync (${sources.length} sources)` : `Transferring data via rsync (${sources.length} sources)`,
        task: async (ctx, task) => {
          ctx.transferStart = Date.now();
          const timer = setInterval(() => {
            const elapsed = formatDuration(Date.now() - ctx.transferStart);
            task.title = `${dryRun ? 'Previewing transfer' : 'Transferring data'} via rsync (${sources.length} sources) [${elapsed} elapsed]`;
          }, 1000);

          try {
            await executeTransfer(sources, destination, (progressLine) => {
               task.output = progressLine;
            }, { dryRun });
          } finally {
            clearInterval(timer);
          }
          
          ctx.transferEnd = Date.now();
          task.title = `${dryRun ? 'Preview' : 'Transfer'} complete [${formatDuration(ctx.transferEnd - ctx.transferStart)}]`;
        }
      },
      {
        title: 'Flushing OS caches to physical media',
        skip: () => dryRun,
        task: async (ctx, task) => {
          const { execa } = await import('execa');
          await execa('sync');
          task.title = 'Caches flushed to physical media';
        }
      },
      {
        title: 'Verification (xxHash)',
        skip: () => skipHash || dryRun,
        task: async (ctx, task) => {
          ctx.verifyStart = Date.now();
          const timer = setInterval(() => {
            const elapsed = formatDuration(Date.now() - ctx.verifyStart);
            task.title = `Verification (xxHash) [${elapsed} elapsed]`;
          }, 1000);

          try {
            return await task.newListr(
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
                        auditTask.title = `Hashes match (${auditCtx.sourceManifest.size} file${auditCtx.sourceManifest.size === 1 ? '' : 's'} verified)`;
                      }
                    }
                  ], { concurrent: false });
                }
              })), 
              { concurrent: false }
            );
          } finally {
            clearInterval(timer);
            ctx.verifyEnd = Date.now();
            task.title = `Verification complete [${formatDuration(ctx.verifyEnd - ctx.verifyStart)}]`;
          }
        }
      },
      {
        title: 'Cleaning up partial transfer artifacts',
        skip: () => dryRun,
        task: async (ctx, task) => {
          const { execa } = await import('execa');
          const { stdout } = await execa('find', [destination, '-type', 'd', '-name', '.rsync-partial']);
          const dirs = stdout.trim().split('\n').filter(Boolean);
          for (const dir of dirs) {
            if (dir) await execa('rm', ['-rf', dir]);
          }
          task.title = dirs.length > 0
            ? `Cleaned up ${dirs.length} partial transfer artifact${dirs.length > 1 ? 's' : ''}`
            : 'No partial transfer artifacts to clean up';
        }
      }
    ], { concurrent: false, rendererOptions: { collapseSubtasks: false } });

    const transferCtx = await transferTasks.run();
    
    p.outro('All done!');
    
    const { default: prettyBytes } = await import('pretty-bytes');
    let summaryText = `• Sources:\n${sources.map(s => `  - ${pc.bold(s)}`).join('\n')}\n` +
      `• Dest:   ${pc.bold(destination)}\n\n`;

    if (statsInfo) {
      summaryText += `Data transferred:  ${prettyBytes(statsInfo.totalBytes)} (${statsInfo.totalFiles} files)\n`;
    }

    if (transferCtx.transferStart && transferCtx.transferEnd) {
      const tTime = transferCtx.transferEnd - transferCtx.transferStart;
      const speed = (statsInfo && tTime > 0) ? (statsInfo.totalBytes / (tTime / 1000)) : 0;
      summaryText += `Transfer time:     ${formatDuration(tTime)} ${speed > 0 ? `(${prettyBytes(speed)}/s)` : ''}\n`;
    }
    if (transferCtx.verifyStart && transferCtx.verifyEnd) {
       summaryText += `Verification time: ${formatDuration(transferCtx.verifyEnd - transferCtx.verifyStart)}\n`;
    }
    if (transferCtx.transferStart) {
       const totalT = (transferCtx.verifyEnd || transferCtx.transferEnd) - transferCtx.transferStart;
       summaryText += `Total time:        ${formatDuration(totalT)}\n`;
    }
    if (!dryRun && !skipHash && statsInfo) {
       summaryText += `Files verified:    ${statsInfo.totalFiles} / ${statsInfo.totalFiles} ✔\n`;
    }
    
    console.log(boxen(
      `${pc.green(`✔ ${dryRun ? 'Preview' : 'Transfer and verification'} complete.`)}\n\n` + summaryText,
      { padding: 1, margin: 1, borderStyle: 'round', borderColor: 'green' }
    ));

  } catch (e) {
    p.outro(pc.red(`Operation failed: ${e.message || 'Unknown error'}`));
    process.exit(1);
  }
}
