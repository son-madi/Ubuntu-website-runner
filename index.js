#!/usr/bin/env node
/**
 * ⚡ Ninimo Bot 24/7 Universal Launcher
 * Designed for 1-Click Startup on Local PC (Windows/Linux/macOS), VPS, or Railway.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

console.log('\n' + '='.repeat(60));
console.log(`🤖 Starting Ninimo 24/7 Minecraft Bot Server [${isDev ? 'Development' : 'Production'}]...`);
console.log('='.repeat(60));

// Step 1: Ensure persistent data directory exists
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {}
}

// Step 2: Ensure node_modules exists
if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
  console.log('📦 [Auto-Setup] node_modules not found. Installing dependencies...');
  try {
    execSync('npm install --legacy-peer-deps', { stdio: 'inherit', cwd: __dirname });
    console.log('✅ [Auto-Setup] Dependencies installed successfully!');
  } catch (err) {
    console.error('⚠️ [Auto-Setup] Failed to install dependencies via npm:', err?.message || err);
  }
}

// Step 3: In production mode, ensure dist/server.cjs and dist/index.html exist
const serverBundlePath = path.join(__dirname, 'dist', 'server.cjs');
const clientBundlePath = path.join(__dirname, 'dist', 'index.html');

if (!isDev && (!fs.existsSync(serverBundlePath) || !fs.existsSync(clientBundlePath))) {
  console.log('⚡ [Auto-Build] Production build not found. Compiling dashboard and server...');
  try {
    execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
    console.log('✅ [Auto-Build] Build finished successfully!');
  } catch (err) {
    console.error('⚠️ [Auto-Build Error]:', err?.message || err);
  }
}

// Step 4: Run the server
try {
  if (!isDev && fs.existsSync(serverBundlePath)) {
    // Run production CommonJS bundled server
    await import('./dist/server.cjs');
  } else {
    console.log('🚀 Running server with live TypeScript compilation (tsx)...');
    execSync('npx tsx server.ts', { stdio: 'inherit', cwd: __dirname });
  }
} catch (err) {
  console.error('❌ Fatal launch error:', err);
  process.exit(1);
}
