import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { parse as parseYaml } from 'yaml';

const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config.development.yml');

const { allowedHosts } = parseYaml(fs.readFileSync(configPath, 'utf-8')) as { allowedHosts: string[] };

export default defineConfig({
  plugins: [cloudflare({ inspectorPort: 9234 })],
  server: { allowedHosts },
});
