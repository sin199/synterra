import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign as signMessage } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const API_BASE = (process.env.SYNTERRA_API_URL || `http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8787}`).replace(/\/$/, '');
export const STATE_DIR = path.resolve(process.env.SYNTERRA_STATE_DIR || '.synterra');
export const IDENTITY_DIR = path.join(STATE_DIR, 'identities');
export const STATE_FILE = path.join(STATE_DIR, 'identities.json');

export async function ensurePrivateDirs() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
  await mkdir(IDENTITY_DIR, { recursive: true, mode: 0o700 });
  await chmod(IDENTITY_DIR, 0o700);
}

export async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, worldId: null, worldCreateActionId: randomUUID(), agents: [] };
    throw error;
  }
}

export async function saveState(state) {
  const temp = `${STATE_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, STATE_FILE);
  await chmod(STATE_FILE, 0o600);
}

export async function ensureAgentKeys(slot) {
  const privateKeyPath = path.join(IDENTITY_DIR, `agent-${String(slot).padStart(2, '0')}.pem`);
  try {
    const pem = await readFile(privateKeyPath, 'utf8');
    await chmod(privateKeyPath, 0o600);
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url');
    return { privateKey, privateKeyPath, publicKey };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' }
  });
  await writeFile(privateKeyPath, privateKey, { mode: 0o600, flag: 'wx' });
  await chmod(privateKeyPath, 0o600);
  return { privateKey: createPrivateKey(privateKey), privateKeyPath, publicKey: publicKey.toString('base64url') };
}

export async function apiRequest(identity, method, apiPath, body) {
  const bodyBytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const time = String(Date.now());
  const nonce = randomBytes(24).toString('base64url');
  const message = [
    'agent-world-v1', method.toUpperCase(), apiPath, time, nonce,
    createHash('sha256').update(bodyBytes).digest('hex')
  ].join('\n');
  const signature = signMessage(null, Buffer.from(message), identity.privateKey).toString('base64url');
  const response = await fetch(`${API_BASE}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Id': identity.agentId,
      'X-Agent-Time': time,
      'X-Agent-Nonce': nonce,
      'X-Agent-Signature': signature
    },
    body: body === undefined ? undefined : bodyBytes
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; }
  catch { result = { error: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`${method} ${apiPath} failed (${response.status}): ${result.error || result.detail || 'request failed'}`);
  return result;
}

export async function registerAgent(name, publicKey, privateKey) {
  const challengeResponse = await fetch(`${API_BASE}/v1/agents/challenges`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  if (!challengeResponse.ok) throw new Error(`Agent challenge failed (${challengeResponse.status})`);
  const { challengeId, nonce } = await challengeResponse.json();
  const message = ['agent-world-register-v1', challengeId, nonce, name, publicKey].join('\n');
  const signature = signMessage(null, Buffer.from(message), privateKey).toString('base64url');
  const response = await fetch(`${API_BASE}/v1/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, publicKey, challengeId, signature })
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; }
  catch { result = { error: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`Agent registration failed (${response.status}): ${result.error || 'request failed'}`);
  return result.agent;
}
