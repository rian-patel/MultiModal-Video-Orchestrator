import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { registerHealthRoutes } from './routes/health';
import { registerRunRoutes } from './routes/runs';
import { RunRegistry } from './runs';

const MAX_PHOTO_BYTES = 30 * 1024 * 1024; // 30 MB per photo

export interface AppOptions {
  /** Override where per-project working dirs live (tests use a temp dir). */
  projectsDir?: string;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  // Engine logs already go to the console; keep fastify's own logger quiet.
  const app = Fastify({ logger: false });
  const registry = new RunRegistry();

  await app.register(multipart, {
    limits: { files: 40, fileSize: MAX_PHOTO_BYTES },
  });

  registerHealthRoutes(app);
  registerRunRoutes(app, registry, opts.projectsDir);

  return app;
}
