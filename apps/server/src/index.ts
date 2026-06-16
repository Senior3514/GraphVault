import { mkdir } from 'node:fs/promises';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { preflightConfig } from './preflight.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // --- production safety preflight: fail fast on insecure prod config -------
  // In production, any error aborts the boot with a non-zero exit so a VPS never
  // comes up with an open CORS policy, plaintext transport, or a postgres
  // backend with no DSN. Warnings are printed but do not block. Dev/test are
  // skipped entirely inside preflightConfig, so local http dev is unaffected.
  const { errors, warnings } = preflightConfig(config, config.nodeEnv);
  for (const warning of warnings) {
    console.warn(`[preflight] WARNING: ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[preflight] ERROR: ${error}`);
    }
    console.error(
      `[preflight] Refusing to start in production with ${errors.length} ` +
        `insecure configuration error(s). Fix the above and restart.`,
    );
    process.exit(1);
  }

  // Ensure the data directory exists so blob writes don't race on first use.
  await mkdir(config.dataDir, { recursive: true });

  const app = await buildApp(config);

  // --- graceful shutdown: drain in-flight requests, then exit cleanly -------
  // A double signal (impatient operator or orchestrator) is guarded so we don't
  // call app.close() twice or wedge the process.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      app.log.warn(`Received ${signal} again while shutting down; ignoring.`);
      return;
    }
    shuttingDown = true;
    app.log.info(`Received ${signal}; shutting down gracefully…`);
    app
      .close()
      .then(() => {
        app.log.info('Shutdown complete.');
        process.exit(0);
      })
      .catch((err) => {
        app.log.error(err, 'Error during shutdown.');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      `GraphVault server listening on http://${config.host}:${config.port} (storage=${config.storage})`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
