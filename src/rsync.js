import { execa } from 'execa';

const RSYNC_ERRORS = {
  1: 'Syntax error in rsync command arguments.',
  2: 'Protocol incompatibility between rsync versions.',
  3: 'File selection errors — check source paths.',
  5: 'Startup error — is the destination drive still connected?',
  10: 'Socket I/O error — check network or drive connection.',
  11: 'File I/O error — the drive may have disconnected. Check USB cable and retry.',
  12: 'rsync protocol data stream error.',
  20: 'Transfer interrupted (SIGUSR1/SIGINT received).',
  23: 'Some files could not be transferred (partial transfer due to error). Successfully transferred files are intact.',
  24: 'Some source files vanished before they could be transferred. This is usually harmless.',
  30: 'Transfer timed out (--timeout). The drive may be sleeping or disconnected.',
};

export async function executeTransfer(sources, destination, onProgress, options = {}) {
  // Normalize paths: strip multiple trailing slashes, preserve '/' for root
  const srcs = sources.map(s => {
    const trimmed = s.replace(/[\/\\]+$/, '');
    return trimmed === '' ? '/' : trimmed;
  });
  
  const destTrimmed = destination.replace(/[\/\\]+$/, '');
  const dest = destTrimmed === '' ? '/' : `${destTrimmed}/`;

  const args = [
    '-rtvlhS',
    '--no-perms',
    '--no-owner',
    '--no-group',
    '--modify-window=2',
    '--partial-dir=.rsync-partial',
    '--timeout=30',
    '--info=progress2',
    '--fsync'
  ];
  
  if (options.dryRun) {
    args.push('-n');
  }
  
  args.push('--', ...srcs, dest);

  const subprocess = execa('rsync', args, { buffer: false });

  let outputBuffer = '';
  let stderrBuffer = '';
  let lastProgressUpdate = 0;

  subprocess.stderr?.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
  });

  subprocess.stdout?.on('data', (chunk) => {
    outputBuffer += chunk.toString();
    const lines = outputBuffer.split(/\r|\n/);
    outputBuffer = lines.pop() || '';

    const now = Date.now();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes('%')) {
        // Throttle progress updates to ~100ms to prevent terminal churn
        if (now - lastProgressUpdate > 100) {
          lastProgressUpdate = now;
          onProgress(trimmed);
        }
      }
    }
  });

  try {
    await subprocess;
    return { success: true };
  } catch (error) {
    const errorDetails = stderrBuffer.trim() || error.message;
    const friendlyMessage = RSYNC_ERRORS[error.exitCode] 
      ? `${RSYNC_ERRORS[error.exitCode]} (Exit code ${error.exitCode})` 
      : `rsync failed with exit code ${error.exitCode}`;
    
    throw new Error(`${friendlyMessage}\nDetails: ${errorDetails}`);
  }
}
