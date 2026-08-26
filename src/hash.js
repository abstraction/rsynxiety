import { execa } from 'execa';
import readline from 'readline';
import { readdir, stat } from 'fs/promises';
import { join, relative, basename, dirname } from 'path';
import prettyBytes from 'pretty-bytes';

export async function getDirectoryStats(dir, canaryFile = '.drive_id', concurrency = 32) {
  let totalBytes = 0;
  let totalFiles = 0;
  const fileSizes = new Map();

  try {
    const s = await stat(dir);
    if (s.isFile()) {
      fileSizes.set(basename(dir), s.size);
      return { totalBytes: s.size, totalFiles: 1, fileSizes };
    }
  } catch (e) {
    return { totalBytes: 0, totalFiles: 0, fileSizes };
  }
  
  const queue = [dir];
  let active = 0;

  await new Promise((resolve, reject) => {
    function next() {
      if (queue.length === 0 && active === 0) {
        return resolve();
      }
      while (queue.length > 0 && active < concurrency) {
        const current = queue.shift();
        active++;
        
        readdir(current, { withFileTypes: true })
          .then(async (entries) => {
            const statTasks = [];
            for (const entry of entries) {
              if ([canaryFile, '.DS_Store', '.rsync-partial'].includes(entry.name)) continue;
              const fullPath = join(current, entry.name);
              
              if (entry.isDirectory()) {
                queue.push(fullPath);
              } else if (entry.isFile()) {
                statTasks.push(
                  stat(fullPath)
                    .then(s => {
                      const rel = relative(dir, fullPath);
                      fileSizes.set(rel, s.size);
                      totalBytes += s.size;
                      totalFiles++;
                    })
                    .catch(() => {})
                );
              }
            }
            await Promise.all(statTasks);
          })
          .catch(() => {})
          .finally(() => {
            active--;
            next();
          });
      }
    }
    next();
  });
  
  return { totalBytes, totalFiles, fileSizes };
}

export async function hashDirectory(baseDir, onProgress, canaryFile = '.drive_id') {
  if (onProgress) onProgress({ status: 'scanning' });
  const stats = await getDirectoryStats(baseDir, canaryFile);
  
  if (stats.totalFiles === 0) {
    if (onProgress) {
      onProgress({
        status: 'hashing',
        percent: 100,
        processedFiles: 0,
        totalFiles: 0,
        currentFile: '',
        eta: '0s',
        speed: '0 B/s'
      });
    }
    // Only return empty map if there were genuinely 0 files
    return new Map();
  }

  let processedBytes = 0;
  let processedFiles = 0;
  const startTime = Date.now();

  let isFile = false;
  try {
    const s = statSync(baseDir);
    isFile = s.isFile();
  } catch (e) {}

  let findProc, hashProc;
  if (isFile) {
    const parentDir = dirname(baseDir);
    const baseName = basename(baseDir);
    findProc = execa('printf', ['%s\\0', baseName], { cwd: parentDir, buffer: false });
    hashProc = execa('xargs', ['-0', 'xxh128sum', '--'], { cwd: parentDir, buffer: false });
  } else {
    findProc = execa('find', [
      '.',
      '-type', 'f',
      '!', '-name', canaryFile,
      '!', '-name', '.DS_Store',
      '!', '-path', '*/.rsync-partial/*',
      '!', '-name', '.rsync-partial',
      '-print0'
    ], { cwd: baseDir, buffer: false });
    hashProc = execa('xargs', ['-0', 'xxh128sum', '--'], { cwd: baseDir, buffer: false });
  }
  
  findProc.stdout.pipe(hashProc.stdin);

  findProc.catch(() => {});

  const manifest = new Map();
  const rl = readline.createInterface({
    input: hashProc.stdout,
    crlfDelay: Infinity
  });

  try {
    for await (const line of rl) {
      const match = line.match(/^\\?([0-9a-fA-F]{32})\s[\s*](.*)$/);
      if (!match) continue;

      const hash = match[1].toLowerCase();
      let relPath = match[2];
      
      if (line.startsWith('\\')) {
        relPath = relPath.replace(/\\([\\nrt])/g, (_, char) => {
          switch (char) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case '\\': return '\\';
            default: return char;
          }
        });
      }

      const cleanRelPath = (relPath.startsWith('./') ? relPath.slice(2) : relPath).normalize('NFC');
      manifest.set(cleanRelPath, hash);

      processedFiles++;
      if (onProgress && stats.totalBytes >= 0) {
        const size = stats.fileSizes.get(cleanRelPath) || 0;
        processedBytes += size;
        
        const percent = Math.min(100, Math.round((processedBytes / stats.totalBytes) * 100));
        const elapsedS = (Date.now() - startTime) / 1000;
        const bytesPerSec = processedBytes / elapsedS;
        const remainingBytes = stats.totalBytes - processedBytes;
        const etaS = bytesPerSec > 0 ? Math.round(remainingBytes / bytesPerSec) : 0;
        
        let etaStr = '';
        if (etaS > 0) {
          const h = Math.floor(etaS / 3600);
          const m = Math.floor((etaS % 3600) / 60);
          const s = Math.floor(etaS % 60);
          if (h > 0) etaStr = `${h}h ${m}m ${s}s`;
          else if (m > 0) etaStr = `${m}m ${s}s`;
          else etaStr = `${s}s`;
        } else {
          etaStr = '0s';
        }

        onProgress({
          status: 'hashing',
          percent,
          processedFiles,
          totalFiles: stats.totalFiles,
          currentFile: cleanRelPath,
          eta: etaStr,
          speed: bytesPerSec > 0 ? `${prettyBytes(bytesPerSec)}/s` : '0 B/s'
        });
      }
    }

    await Promise.all([findProc, hashProc]);
    
    if (stats.totalFiles > 0 && manifest.size === 0) {
      throw new Error(`Verification aborted: Manifest is empty but ${stats.totalFiles} source files were expected. Drive may be disconnected or xargs failed.`);
    }

    return manifest;
  } catch (error) {
    if (error.exitCode === 123 && !error.stderr) {
       return new Map();
    }
    if (error.exitCode === 127 || error.message?.includes('ENOENT')) {
      throw new Error(`Required system command not found. Install 'find', 'xargs', and 'xxh128sum'. Underlying error: ${error.message}`);
    }
    throw new Error(`Hashing failed on directory '${baseDir}'. Details: ${error.stderr || error.message}`);
  }
}

export function compareManifests(sourceManifest, destManifest) {
  const errors = [];
  
  for (const [filepath, sourceHash] of sourceManifest.entries()) {
    const destHash = destManifest.get(filepath);
    if (!destHash) {
      errors.push(`Missing in destination: ${filepath}`);
    } else if (sourceHash !== destHash) {
      errors.push(`Hash mismatch (Corruption): ${filepath}`);
    }
  }

  for (const [filepath] of destManifest.entries()) {
    if (!sourceManifest.has(filepath)) {
      errors.push(`Extraneous file in destination: ${filepath}`);
    }
  }

  return errors;
}

import { statSync, readFileSync } from 'fs';
import { execSync, execFileSync } from 'child_process';

function getDeviceTopology(dirPath) {
  try {
    const devId = statSync(dirPath).dev;
    let parentDisk = dirPath;
    let isRotational = true;
    try {
      const dfOutput = execFileSync('df', ['--output=source', dirPath], { encoding: 'utf8' }).trim().split('\n')[1];
      const match = dfOutput.match(/\/dev\/([a-z]+|[a-z]+[0-9]+n[0-9]+)/);
      parentDisk = match ? match[1].replace(/[0-9]+$/, '') : dfOutput;
      
      const rot = readFileSync(`/sys/block/${parentDisk}/queue/rotational`, 'utf8').trim();
      isRotational = rot === '1';
    } catch {
      // Fallback
    }

    return { devId, parentDisk, isRotational };
  } catch {
    return { devId: null, parentDisk: dirPath, isRotational: true };
  }
}

export function shouldHashSequentially(source, destination) {
  const srcTopo = getDeviceTopology(source);
  const dstTopo = getDeviceTopology(destination);

  if ((srcTopo.isRotational || dstTopo.isRotational) && srcTopo.parentDisk === dstTopo.parentDisk) {
    return true;
  }
  return false;
}
