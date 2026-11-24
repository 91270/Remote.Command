import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--with-image') || args.length > 1) throw new Error('Usage: npm run package:release -- [--with-image]');
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const tag = `${manifest.name}:${manifest.version}`;
const stem = `${manifest.name}-${manifest.version}`;
const stage = await mkdtemp(join(tmpdir(), 'rcm-release-'));
const directory = join(stage, stem);
const releases = join(root, 'releases');
const sourceFiles = ['.dockerignore', '.npmrc', 'Dockerfile', 'compose.yaml', 'package.json', 'package-lock.json',
  'tsconfig.json', 'agent.example.json', 'README.md', 'scripts/backup.mjs', 'scripts/package-client.mjs',
  'docs/production.md', 'docs/verification.md', 'src', 'web', 'deploy/gateway',
  'deploy/nginx/remote-command.conf', 'vendor'];

async function stageEntry(path) {
  const from = join(root, path), to = join(directory, path);
  await mkdir(dirname(to), { recursive: true });
  const entries = await readdir(from, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (!entries) { await writeFile(to, await readFile(from)); return; }
  for (const child of entries) {
    if (child.name.startsWith('._') || child.name === '.DS_Store') continue;
    if (!child.isDirectory() && !child.isFile()) throw new Error('Unexpected entry in release sources: ' + child.name);
    await stageEntry(join(path, child.name));
  }
}

async function gzipImage(file) {
  const child = spawn('docker', ['image', 'save', tag], { stdio: ['ignore', 'pipe', 'inherit'] });
  const completed = once(child, 'close');
  try {
    const [[code, signal]] = await Promise.all([completed, pipeline(child.stdout, createGzip(), createWriteStream(file))]);
    if (code !== 0) throw new Error('Docker image export failed: ' + (signal ?? code));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await completed.catch(() => {});
  }
}

async function sha(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

try {
  for (const path of sourceFiles) await stageEntry(path);
  const stagedCompose = join(directory, 'compose.yaml');
  const compose = await readFile(stagedCompose, 'utf8');
  const imageTag = /^(    image: ghcr\.io\/[^:\s]+:)[^\s]+$/m;
  if (!imageTag.test(compose)) throw new Error('Expected a GHCR default image in compose.yaml.');
  await writeFile(stagedCompose, compose.replace(imageTag, (_, prefix) => prefix + manifest.version));

  const client = stem + '.tgz';
  execFileSync(process.execPath, [join(root, 'scripts', 'package-client.mjs'), stage], { stdio: 'inherit' });
  await copyFile(join(stage, client), join(directory, client));
  const composeFile = stem + '-compose.yaml';
  const deployment = stem + '-deploy.tar.gz';
  const files = [client, composeFile, deployment];
  await copyFile(stagedCompose, join(stage, composeFile));
  execFileSync('tar', ['-czf', join(stage, deployment), '-C', stage, stem], { stdio: 'inherit' });

  if (args.includes('--with-image')) {
    execFileSync('docker', ['build', '--tag', tag, directory], { stdio: 'inherit' });
    const images = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8' }));
    const platform = images[0].Os + '-' + images[0].Architecture;
    if (!/^linux-(?:amd64|arm64)$/.test(platform)) throw new Error('Unsupported Gateway image platform: ' + platform);
    const image = stem + '-gateway-' + platform + '.tar.gz';
    await gzipImage(join(stage, image));
    files.push(image);
  }
  const sums = [];
  for (const file of files) sums.push(`${await sha(join(stage, file))}  ${file}`);
  const checksums = stem + '-SHA256SUMS';
  await writeFile(join(stage, checksums), sums.join('\n') + '\n');

  await mkdir(releases, { recursive: true });
  const publish = await mkdtemp(join(releases, '.build-'));
  try {
    for (const file of [...files, checksums]) await copyFile(join(stage, file), join(publish, file));
    for (const file of [...files, checksums]) {
      await rename(join(publish, file), join(releases, file));
      console.log(join(releases, file));
    }
  } finally { await rm(publish, { recursive: true, force: true }); }
} finally { await rm(stage, { recursive: true, force: true }); }
