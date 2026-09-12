import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { chromium } from '@playwright/test';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../packages/db/src/schema';
import { migrate } from '../../packages/db/src/migrate';
import { openDatabase } from '../../packages/db/src/node';
import { createApp } from '../../apps/api/src/app';
import { createAuth, resolvePrincipal } from '../../apps/api/src/auth';

const root = resolve('.');

function delay(milliseconds: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `${command} failed (${code ?? signal ?? 'unknown'})${stderr ? `: ${stderr}` : ''}`,
          ),
        );
    });
  });
}

async function requestJson(
  request: import('@playwright/test').APIRequestContext,
  origin: string,
  path: string,
  body?: unknown,
) {
  const response = await request.fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin },
    data: body,
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = await response.text();
  }
  return { status: response.status(), value };
}

async function allocatePort() {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = probe.address();
  if (!address || typeof address === 'string')
    throw new Error('GOVERNANCE_E2E_PORT_ALLOCATED_INVALID');
  const port = address.port;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}

async function startApi(dbPath: string, secret: string) {
  const { db, sqlite } = openDatabase(dbPath);
  await migrate(sqlite);
  const port = await allocatePort();
  // Chromium's virtual authenticator rejects an IP address as an RP ID on the
  // local HTTP origin. `localhost` is a browser-recognized trustworthy origin
  // and keeps the RP ID/origin pair consistent while the server still binds
  // only to loopback.
  const origin = `http://localhost:${port}`;
  const auth = createAuth(drizzle(sqlite, { schema }), secret, origin, db);
  const app = createApp(
    db,
    {
      mode: 'demo',
      intakeEnabled: true,
      promotionEnabled: false,
      productionReleaseEnabled: false,
      origins: [origin],
      rateSecret: secret,
    },
    (headers) => resolvePrincipal(auth, db, headers),
    (request) => auth.handler(request),
  );
  let server: ServerType;
  await new Promise<void>((resolvePromise) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => resolvePromise());
  });
  return { origin, server: server!, sqlite };
}

async function stopApi(api: { server: ServerType; sqlite: { close(): void } }) {
  await new Promise<void>((resolvePromise) => api.server.close(() => resolvePromise()));
  api.sqlite.close();
}

function getCredentialPair(text: string, email: string) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`邮箱：${escaped}\\n初始密码：([^\\n]+)`));
  if (!match || match[1].startsWith('本次未生成'))
    throw new Error('GOVERNANCE_E2E_CREDENTIALS_UNAVAILABLE');
  return { email, password: match[1] };
}

async function main() {
  await mkdir(resolve('.runtime/private'), { recursive: true, mode: 0o700 });
  const runDir = await mkdtemp(join(resolve('.runtime/private'), 'governance-e2e-'));
  const dbPath = join(runDir, 'governance-demo.db');
  const credentialPath = join(runDir, 'credentials.txt');
  const modePath = join(runDir, 'mode.json');
  const secret = `governance-e2e-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    await run('pnpm', ['exec', 'tsx', 'scripts/governance-demo.ts'], {
      ...process.env,
      WFD_GOVERNANCE_DEMO_DB: dbPath,
      WFD_GOVERNANCE_DEMO_CREDENTIALS: credentialPath,
      WFD_GOVERNANCE_DEMO_MODE: modePath,
      WFD_INTAKE_DB: join(runDir, 'intake.db'),
    });
    const credentials = getCredentialPair(
      await readFile(credentialPath, 'utf8'),
      'governance.one@example.invalid',
    );
    api = await startApi(dbPath, secret);
    const apiOrigin = api.origin;

    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(apiOrigin + '/health');
    const browserSupport = await page.evaluate(() => ({
      origin: location.origin,
      secureContext: window.isSecureContext,
      credentialsApi: typeof navigator.credentials?.create === 'function',
      publicKeyApi: typeof PublicKeyCredential !== 'undefined',
    }));
    if (
      !browserSupport.secureContext ||
      !browserSupport.credentialsApi ||
      !browserSupport.publicKeyApi
    )
      throw new Error('GOVERNANCE_E2E_WEBAUTHN_UNAVAILABLE: ' + JSON.stringify(browserSupport));

    const signedIn = await requestJson(
      context.request,
      apiOrigin,
      '/admin/v1/auth/sign-in/email',
      credentials,
    );
    if (signedIn.status !== 200)
      throw new Error(`GOVERNANCE_E2E_SIGN_IN_FAILED:${JSON.stringify(signedIn.value)}`);
    const registration = await requestJson(
      context.request,
      apiOrigin,
      '/admin/v1/security/webauthn/registration/options',
      {},
    );
    if (registration.status !== 200)
      throw new Error(
        `GOVERNANCE_E2E_REGISTRATION_OPTIONS_FAILED:${registration.status}:${JSON.stringify(registration.value)}`,
      );
    const registrationResponse = await page.evaluate(`(async () => {
      const value = ${JSON.stringify(registration.value)};
      const options = value.options;
      function decode(input) {
        const normalized = input
          .split('-')
          .join('+')
          .split('_')
          .join('/')
          .padEnd(Math.ceil(input.length / 4) * 4, '=');
        return Uint8Array.from(atob(normalized), function (character) {
          return character.charCodeAt(0);
        });
      }
      function encode(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).split('=').join('').split('+').join('-').split('/').join('_');
      }
      const publicKey = {
        ...options,
        challenge: decode(options.challenge),
        user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map(function (item) {
          return { ...item, id: decode(item.id) };
        }),
      };
      const credential = await navigator.credentials.create({ publicKey });
      if (!credential) throw new Error('WEBAUTHN_CREATE_RETURNED_NULL');
      const response = credential.response;
      const publicKeyBytes = response.getPublicKey?.();
      const authenticatorData = response.getAuthenticatorData?.();
      return {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: encode(response.clientDataJSON),
          attestationObject: encode(response.attestationObject),
          transports: response.getTransports?.(),
          publicKeyAlgorithm: response.getPublicKeyAlgorithm?.(),
          publicKey: publicKeyBytes ? encode(publicKeyBytes) : undefined,
          authenticatorData: authenticatorData ? encode(authenticatorData) : undefined,
        },
        clientExtensionResults: credential.getClientExtensionResults(),
        ...(credential.authenticatorAttachment
          ? { authenticatorAttachment: credential.authenticatorAttachment }
          : {}),
      };
    })()`);
    const registrationResult = await requestJson(
      context.request,
      apiOrigin,
      '/admin/v1/security/webauthn/registration/verify',
      {
        challenge_id: (registration.value as { challenge_id: string }).challenge_id,
        response: registrationResponse,
      },
    );
    if (registrationResult.status !== 200)
      throw new Error(
        `GOVERNANCE_E2E_REGISTRATION_VERIFY_FAILED:${registrationResult.status}:${JSON.stringify({
          result: registrationResult.value,
          responseKeys: Object.keys((registrationResponse ?? {}) as object),
          nestedKeys: Object.keys(
            ((registrationResponse ?? {}) as { response?: object }).response ?? {},
          ),
        })}`,
      );

    const stepUp = await requestJson(
      context.request,
      apiOrigin,
      '/admin/v1/security/webauthn/step-up/options',
      {},
    );
    if (stepUp.status !== 200) throw new Error('GOVERNANCE_E2E_STEP_UP_OPTIONS_FAILED');
    const assertionResponse = await page.evaluate(`(async () => {
      const value = ${JSON.stringify(stepUp.value)};
      const options = value.options;
      function decode(input) {
        const normalized = input
          .split('-')
          .join('+')
          .split('_')
          .join('/')
          .padEnd(Math.ceil(input.length / 4) * 4, '=');
        return Uint8Array.from(atob(normalized), function (character) {
          return character.charCodeAt(0);
        });
      }
      function encode(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).split('=').join('').split('+').join('-').split('/').join('_');
      }
      const publicKey = {
        ...options,
        challenge: decode(options.challenge),
        allowCredentials: (options.allowCredentials || []).map(function (item) {
          return { ...item, id: decode(item.id) };
        }),
      };
      const credential = await navigator.credentials.get({ publicKey });
      if (!credential) throw new Error('WEBAUTHN_GET_RETURNED_NULL');
      const response = credential.response;
      return {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: encode(response.clientDataJSON),
          authenticatorData: encode(response.authenticatorData),
          signature: encode(response.signature),
          ...(response.userHandle ? { userHandle: encode(response.userHandle) } : {}),
        },
        clientExtensionResults: credential.getClientExtensionResults(),
        ...(credential.authenticatorAttachment
          ? { authenticatorAttachment: credential.authenticatorAttachment }
          : {}),
      };
    })()`);
    const stepUpResult = await requestJson(
      context.request,
      apiOrigin,
      '/admin/v1/security/webauthn/step-up/verify',
      {
        challenge_id: (stepUp.value as { challenge_id: string }).challenge_id,
        response: assertionResponse,
      },
    );
    if (stepUpResult.status !== 200)
      throw new Error(
        `GOVERNANCE_E2E_STEP_UP_VERIFY_FAILED:${stepUpResult.status}:${JSON.stringify(stepUpResult.value)}`,
      );
    await context.close();
    console.log(
      `Chromium WebAuthn 真实虚拟认证器注册与 step-up 通过（${browserSupport.origin}）。`,
    );
  } finally {
    await browser.close();
    if (api) await stopApi(api);
    await rm(runDir, { recursive: true, force: true });
  }
}

await main();
