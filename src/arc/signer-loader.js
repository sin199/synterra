import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertArcSigner } from './wallet-provider.js';

const SUPPORTED_SIGNER_PROVIDERS = new Set(['external_kms','managed_wallet']);

export async function loadConfiguredArcSigner({ config, env = process.env }) {
  const providerName = String(env.ARC_SIGNER_PROVIDER || '').trim();
  const adapterPath = String(env.ARC_SIGNER_ADAPTER_MODULE || '').trim();
  if (!providerName && !adapterPath) return { signer: null, configured: false, reason: 'signer_not_configured' };
  if (!SUPPORTED_SIGNER_PROVIDERS.has(providerName) || !path.isAbsolute(adapterPath)) {
    const error = new Error('Arc signer configuration requires a supported provider and an absolute local adapter path.');
    error.code = 'ARC_SIGNER_CONFIGURATION_INVALID';
    throw error;
  }
  const adapterUrl = pathToFileURL(adapterPath).href;
  const adapter = await import(adapterUrl);
  if (typeof adapter.createArcSigner !== 'function') {
    const error = new Error('Arc signer adapter must export createArcSigner().');
    error.code = 'ARC_SIGNER_ADAPTER_INVALID';
    throw error;
  }
  const signer = await adapter.createArcSigner({ config, env, providerName });
  assertArcSigner(signer, config);
  if (signer.providerName !== providerName) {
    const error = new Error('Arc signer provider name does not match its configured wallet provider.');
    error.code = 'ARC_SIGNER_PROVIDER_MISMATCH';
    throw error;
  }
  return { signer, configured: true, providerName };
}
