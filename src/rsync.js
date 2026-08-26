import { execa } from 'execa';

export async function executeTransfer(sources, destination, onProgress) {
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
    '--fsync',
    '--',
    ...srcs,
    dest
  ];

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
    throw new Error(`rsync failed with exit code ${error.exitCode}: ${errorDetails}`);
  }
}
