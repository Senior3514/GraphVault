import { mkdir } from 'node:fs/promises';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Ensure the data directory exists so blob writes don't race on first use.
  await mkdir(config.dataDir, { recursive: true });

  const app = await buildApp(config);

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
