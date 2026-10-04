import { access, chmod, cp, mkdtemp, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/install-web-client.mjs /path/to/openlogtool/build/web');
const source = resolve(process.argv[2]);
const destination = join(root, 'web-client');
if (source === destination || source.startsWith(`${destination}/`)) throw new Error('Source must be a separate WebClient build');
for (const file of ['index.html', 'main.dart.js', 'pkg/openlogtool_core.js', 'pkg/openlogtool_core_bg.wasm']) {
  await access(join(source, file), constants.R_OK);
}
const staging = await mkdtemp(join(root, '.web-client-stage-'));
await cp(source, staging, { recursive: true });
// mkdtemp is private by default; the Docker node user needs to read this bundle.
await chmod(staging, 0o755);
let backup;
try { await access(destination); backup = `${destination}.backup-${Date.now()}`; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (backup) await rename(destination, backup);
try { await rename(staging, destination); } catch (error) {
  if (backup) await rename(backup, destination);
  throw error;
}
console.log(`Installed WebClient at ${destination}. Restart the server, then open /connect or /client/.`);
if (backup) console.log(`Previous build preserved at ${backup}`);
