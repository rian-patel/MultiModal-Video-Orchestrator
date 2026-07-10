import { join } from 'node:path';
import { createLogger } from '@rev/core';
import { buildApp } from './app';
import { PROJECTS_DIR, REPO_ROOT } from './paths';

// Load <repo>/.env (ANTHROPIC_API_KEY etc.) before anything reads process.env.
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch {
  // .env is optional — engines that need keys fall back to mocks.
}

const PORT = 3001;
const logger = createLogger('server');

logger.info(
  process.env.ANTHROPIC_API_KEY
    ? 'Vision: Claude (ANTHROPIC_API_KEY found)'
    : 'Vision: mock (no ANTHROPIC_API_KEY — add it to .env for real analysis)',
);
logger.info(
  process.env.HIGGSFIELD_API_KEY
    ? 'VideoGen: Higgsfield (HIGGSFIELD_API_KEY found)'
    : 'VideoGen: mock (no HIGGSFIELD_API_KEY — add it to .env for real clips)',
);

buildApp()
  .then((app) => app.listen({ port: PORT, host: '127.0.0.1' }))
  .then((address) => {
    logger.info(`API listening on ${address}`);
    logger.info(`Projects dir: ${PROJECTS_DIR}`);
  })
  .catch((err) => {
    logger.error('Failed to start server', err);
    process.exit(1);
  });
