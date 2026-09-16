import fs from 'fs';
import path from 'path';

/**
 * Resolves the primary data directory for persistent storage across:
 * - Local development and PC / Linux execution
 * - AI Studio Cloud Run container
 * - Railway Deployments with or without Railway Volumes (e.g., RAILWAY_VOLUME_MOUNT_PATH or DATA_DIR)
 */
export function resolveDataDir(): string {
  const custom =
    process.env.DATA_DIR ||
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    process.env.PERSISTENT_DATA_PATH;

  let chosenDir = custom
    ? path.resolve(custom)
    : path.join(process.cwd(), 'data');

  // If running inside a container where /data exists as a volume mount, prefer /data
  if (!custom && fs.existsSync('/data') && !fs.existsSync(path.join(process.cwd(), 'server.ts'))) {
    try {
      fs.accessSync('/data', fs.constants.W_OK);
      chosenDir = '/data';
    } catch {}
  }

  // Ensure directory exists
  if (!fs.existsSync(chosenDir)) {
    try {
      fs.mkdirSync(chosenDir, { recursive: true });
    } catch {}
  }

  // Migration & Seeding: If user mounts a clean Railway volume or custom directory,
  // automatically copy the initial seed files (like users.json with Shifin admin)
  // so data is never lost or blanked out when deploying with a new volume.
  const localDefaultDir = path.join(process.cwd(), 'data');
  if (path.resolve(chosenDir) !== path.resolve(localDefaultDir) && fs.existsSync(localDefaultDir)) {
    const seedFiles = [
      'users.json',
      'bot-configs.json',
      'sessions.json',
      'quick-tokens.json',
      'system-settings.json',
      'user-defaults.json',
      'general_chat.json',
      'chat_config.json',
    ];
    for (const file of seedFiles) {
      const src = path.join(localDefaultDir, file);
      const dst = path.join(chosenDir, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try {
          fs.copyFileSync(src, dst);
          console.log(`[Storage Seeder] Initialized ${file} into volume directory: ${chosenDir}`);
        } catch (err) {
          console.warn(`[Storage Seeder Notice] Failed to seed ${file}:`, err);
        }
      }
    }
  }

  return chosenDir;
}

export const DATA_DIR = resolveDataDir();
