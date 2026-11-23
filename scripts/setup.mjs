import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const domain = process.argv[2] ?? '';
const redirect = process.argv[3] ?? 'https://chatgpt.com/connector_platform_oauth_redirect';
if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain) ||
    !/^https:\/\/chatgpt\.com\/(?:connector_platform_oauth_redirect|connector\/oauth\/[A-Za-z0-9_-]+)$/.test(redirect)) {
  console.error('Usage: npm run setup -- mcp.example.com [exact ChatGPT redirect URI]');
  process.exitCode = 1;
} else {
  const secret = () => randomBytes(32).toString('base64url');
  await writeFile('.env', [
    'DOMAIN=' + domain,
    'PUBLIC_ORIGIN=https://' + domain,
    'OAUTH_CLIENT_ID=prm_' + randomBytes(12).toString('hex'),
    'OAUTH_CLIENT_SECRET=' + secret(),
    'OWNER_KEY=' + secret(),
    'OAUTH_REDIRECT_URIS=' + redirect,
    ''
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created .env; keep it private. Use the OAuth client ID and client secret in ChatGPT.');
}
