import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseDir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'releases');
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'prm-package-'));
const runtime = ['agent', 'agent-config', 'agent-service', 'client-commands', 'client-events', 'command',
  'dc-core', 'local-mcp', 'protocol', 'remote-cli', 'vendor', 'workspace'];
const json = value => JSON.stringify(value, null, 2) + '\n';

try {
  const manifest = {
    name: source.name,
    version: source.version,
    description: 'Remote.Command client for self-hosted device access',
    private: true,
    type: source.type,
    engines: source.engines,
    bin: source.bin,
    dependencies: source.dependencies,
    files: ['dist/', 'vendor/', 'agent.example.json', 'npm-shrinkwrap.json']
  };
  delete lock.packages[''].devDependencies;
  for (const [path, item] of Object.entries(lock.packages)) {
    if (item.dev) delete lock.packages[path];
  }
  await mkdir(join(stage, 'dist'));
  for (const module of runtime) {
    const path = join('dist', module + '.js');
    await copyFile(join(root, path), join(stage, path));
  }
  await chmod(join(stage, 'dist', 'remote-cli.js'), 0o755);
  await cp(join(root, 'vendor'), join(stage, 'vendor'), { recursive: true });
  await copyFile(join(root, 'agent.example.json'), join(stage, 'agent.example.json'));
  await copyFile(join(root, 'README.md'), join(stage, 'README.md'));
  await writeFile(join(stage, 'package.json'), json(manifest));
  await writeFile(join(stage, 'npm-shrinkwrap.json'), json(lock));
  await mkdir(releaseDir, { recursive: true });

  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run the package script with npm run package:client.');
  const output = execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--cache', join(stage, '.npm-cache'), '--pack-destination', releaseDir], {
    cwd: stage, encoding: 'utf8'
  });
  const [packed] = JSON.parse(output);
  console.log(join(releaseDir, packed.filename));
} finally { await rm(stage, { recursive: true, force: true }); }
