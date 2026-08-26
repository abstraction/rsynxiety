#!/usr/bin/env node

import { program } from 'commander';
import { runWizard } from '../src/index.js';
import { resolve } from 'path';

program
  .name('rsynxiety')
  .description('A verified local file transfer tool')
  .version('1.0.0')
  .argument('[paths...]', 'Source directories followed by Destination directory')
  .option('--canary <filename>', 'Require a specific canary/sentinel file (e.g. .drive_id) on the destination')
  .option('--skip-hash', 'Skip the hash verification phase')
  .action(async (paths, options) => {
    try {
      let sources = [];
      let destination = undefined;
      
      if (paths.length > 1) {
        destination = resolve(paths.pop());
        sources = paths.map(p => resolve(p));
      } else if (paths.length === 1) {
        sources = [resolve(paths[0])];
      }
      
      await runWizard({ sources, destination, ...options });
    } catch (error) {
      console.error('\nFatal error:', error.message);
      process.exit(1);
    }
  });

program.parse();
