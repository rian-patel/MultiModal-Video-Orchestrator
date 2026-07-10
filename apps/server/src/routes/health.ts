import type { FastifyInstance } from 'fastify';
import type { HealthData } from '@rev/core';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async (): Promise<HealthData> => ({
    ok: true,
    service: 'rev-server',
    engines: {
      vision: process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock',
      videogen: 'ken-burns',
      cinematicAvailable: Boolean(process.env.HIGGSFIELD_API_KEY),
    },
  }));
}
