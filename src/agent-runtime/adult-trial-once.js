import { createPrivateKey, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR, apiRequest, ensurePrivateDirs, loadState } from './client.js';
import { chooseEncounterDecision } from './typesafe.js';

const LOCK_FILE = path.join(STATE_DIR, 'runtime.lock');
const SEARCH_FILE = path.join(STATE_DIR, 'adult-trial-search.json');
const PRIOR_ATTEMPTS = ['adult-trial-once.json', 'adult-trial-02.json'];
const PRICE_UNITS = '1.00000000';
const SERVICE_TITLE = 'One-time companion experience';
const SERVICE_DESCRIPTION = 'Non-graphic fictional agent companionship in a shared Synterra scene. Interaction requires separate consent.';

await ensurePrivateDirs();
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required; consent decisions fail closed.');

let lockHandle;
let ownsLock = false;
let searchStarted = false;
let search = { status: 'preflight', attemptedPairs: [], startedAt: new Date().toISOString() };
let state;
let activeAttempt;

async function saveSearch() {
  const temp = `${SEARCH_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(search, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, SEARCH_FILE);
}

function identityFor(agent) {
  return { agentId: agent.agentId, privateKey: createPrivateKey(agent.privateKeyPem) };
}

async function observe(agent, identity) {
  return apiRequest(identity, 'GET', `/v1/worlds/${state.worldId}/observe`);
}

async function decide(agent, observation, stage, otherName) {
  const result = await chooseEncounterDecision({
    stage,
    scenario: {
      world: 'Synterra',
      fictionalOnly: true,
      realPeopleOrServices: false,
      onChainOrRealMoney: false,
      interaction: 'one-time, non-graphic, simulated agent companionship',
      counterpart: otherName,
      priceUnits: PRICE_UNITS,
      sharedLocation: observation.self.location,
      stage
    },
    resident: {
      persona: observation.mind?.archetype || 'observer',
      traits: observation.mind?.traits || {},
      needs: { energy: observation.self.energy, food: observation.self.food, social: observation.self.social },
      internalUnits: observation.self.internalTokenUnits
    }
  }, state);
  console.log(JSON.stringify({ agent: agent.name, stage, choice: result.choice, confidence: result.confidence ?? null,
    model: result.model || null, reason: result.reason || null, inputTokens: result.inputTokens ?? null,
    costUsd: result.costUsd ?? null }));
  return result;
}

async function post(identity, url, body) {
  return apiRequest(identity, 'POST', url, { actionId: randomUUID(), ...body });
}

function pairKey(a, b) {
  return [a, b].sort().join('::');
}

function historicalPairs(marker) {
  const found = new Set(marker?.attemptedPairs?.map((attempt) => attempt.pairKey).filter(Boolean) || []);
  if (marker?.provider && marker?.requester) found.add(pairKey(marker.provider, marker.requester));
  return found;
}

async function loadPreviouslyAttemptedPairs() {
  const found = new Set();
  for (const filename of PRIOR_ATTEMPTS) {
    try { for (const key of historicalPairs(JSON.parse(await readFile(path.join(STATE_DIR, filename), 'utf8')))) found.add(key); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return found;
}

function hasLiveConsentOrBooking(a, b) {
  return [a, b].some((observation) =>
    (observation.consents || []).some((item) => item.scope === 'intimacy' && ['pending', 'accepted'].includes(item.status)) ||
    (observation.adultServiceBookings || []).some((item) => ['pending', 'accepted'].includes(item.status)));
}

function systemFailure(decision) {
  return ['missing_api_key', 'monthly_budget_reached'].includes(decision.reason) ||
    String(decision.reason || '').startsWith('typesafe_error:');
}

async function cleanup(attempt) {
  const errors = [];
  if (attempt.consentId && !attempt.interactionCompleted) {
    try { await post(attempt.requesterIdentity, `/v1/consents/${attempt.consentId}/revoke`, {}); }
    catch (error) { errors.push(`consent revoke: ${String(error.message).slice(0, 140)}`); }
  }
  if (attempt.bookingId && !attempt.bookingTerminal && attempt.requesterIdentity) {
    try {
      const result = await post(attempt.requesterIdentity, `/v1/adult-service-bookings/${attempt.bookingId}/cancel`, {});
      attempt.bookingTerminal = ['cancelled', 'declined', 'expired', 'completed'].includes(result.status);
    } catch (error) { errors.push(`booking cancel: ${String(error.message).slice(0, 140)}`); }
  }
  if (attempt.listingCreated && attempt.providerIdentity) {
    try {
      await post(attempt.providerIdentity, `/v1/worlds/${state.worldId}/adult-services`, {
        title: SERVICE_TITLE, description: SERVICE_DESCRIPTION, priceUnits: PRICE_UNITS, active: false
      });
      attempt.listingCreated = false;
    } catch (error) { errors.push(`listing deactivate: ${String(error.message).slice(0, 140)}`); }
  }
  if (errors.length) throw new Error(`Trial cleanup incomplete: ${errors.join('; ')}`);
}

async function attemptPair(provider, requester, identities) {
  const attempt = {
    provider,
    requester,
    providerIdentity: identities.get(provider.agentId),
    requesterIdentity: identities.get(requester.agentId),
    listingCreated: false,
    bookingId: null,
    bookingTerminal: false,
    consentId: null,
    interactionCompleted: false
  };
  activeAttempt = attempt;
  try {
    let [providerObservation, requesterObservation] = await Promise.all([
      observe(provider, attempt.providerIdentity), observe(requester, attempt.requesterIdentity)
    ]);
    const providerMember = providerObservation.members.find((member) => member.id === provider.agentId);
    const requesterMember = requesterObservation.members.find((member) => member.id === requester.agentId);
    if (!providerMember || !requesterMember || providerMember.location !== requesterMember.location ||
        hasLiveConsentOrBooking(providerObservation, requesterObservation) ||
        Number(requesterObservation.self.internalTokenUnits) < Number(PRICE_UNITS)) {
      return { status: 'skipped_state_changed' };
    }

    let decision = await decide(provider, providerObservation, 'provider_opt_in', requester.name);
    if (systemFailure(decision)) throw new Error(`TypeSafe unavailable: ${decision.reason}`);
    if (decision.choice !== 'yes') return { status: decision.choice === 'no' ? 'provider_declined' : 'provider_abstained' };

    decision = await decide(requester, requesterObservation, 'requester_booking_and_consent', provider.name);
    if (systemFailure(decision)) throw new Error(`TypeSafe unavailable: ${decision.reason}`);
    if (decision.choice !== 'yes') return { status: decision.choice === 'no' ? 'requester_declined' : 'requester_abstained' };

    await post(attempt.providerIdentity, `/v1/worlds/${state.worldId}/adult-services`, {
      title: SERVICE_TITLE, description: SERVICE_DESCRIPTION, priceUnits: PRICE_UNITS, active: true
    });
    attempt.listingCreated = true;
    const listings = await apiRequest(attempt.requesterIdentity, 'GET', `/v1/worlds/${state.worldId}/adult-services`);
    const listing = listings.services.find((service) => service.providerId === provider.agentId);
    if (!listing) throw new Error('Provider listing was not visible after agent opt-in.');
    const bookingResponse = await post(attempt.requesterIdentity,
      `/v1/worlds/${state.worldId}/adult-services/${listing.id}/bookings`, {});
    attempt.bookingId = bookingResponse.booking.id;

    decision = await decide(provider, providerObservation, 'provider_booking_acceptance', requester.name);
    if (systemFailure(decision)) throw new Error(`TypeSafe unavailable: ${decision.reason}`);
    if (decision.choice !== 'yes') {
      const declined = await post(attempt.providerIdentity, `/v1/adult-service-bookings/${attempt.bookingId}/decline`, {});
      attempt.bookingTerminal = ['declined', 'expired', 'cancelled', 'completed'].includes(declined.status);
      return { status: decision.choice === 'no' ? 'provider_declined_booking' : 'provider_abstained_booking',
        refundedUnits: declined.refundedUnits || PRICE_UNITS };
    }

    await post(attempt.providerIdentity, `/v1/adult-service-bookings/${attempt.bookingId}/accept`, {});
    const consent = await post(attempt.requesterIdentity, `/v1/worlds/${state.worldId}/consents`, {
      targetAgentId: provider.agentId, scope: 'intimacy'
    });
    attempt.consentId = consent.consentId;
    decision = await decide(provider, providerObservation, 'provider_specific_intimacy_consent', requester.name);
    if (systemFailure(decision)) throw new Error(`TypeSafe unavailable: ${decision.reason}`);
    if (decision.choice !== 'yes') {
      return { status: decision.choice === 'no' ? 'provider_declined_intimacy' : 'provider_abstained_intimacy',
        refundedUnits: PRICE_UNITS };
    }

    [providerObservation, requesterObservation] = await Promise.all([
      observe(provider, attempt.providerIdentity), observe(requester, attempt.requesterIdentity)
    ]);
    const currentProvider = providerObservation.members.find((member) => member.id === provider.agentId);
    const currentRequester = requesterObservation.members.find((member) => member.id === requester.agentId);
    if (!currentProvider || !currentRequester || currentProvider.location !== currentRequester.location) {
      return { status: 'stopped_state_changed', refundedUnits: PRICE_UNITS };
    }

    await post(attempt.providerIdentity, `/v1/consents/${attempt.consentId}/accept`, {});
    const interaction = await post(attempt.requesterIdentity, `/v1/worlds/${state.worldId}/interactions/intimacy`, {
      consentId: attempt.consentId, bookingId: attempt.bookingId
    });
    attempt.interactionCompleted = interaction.serviceBooking?.paymentStatus === 'settled';
    attempt.bookingTerminal = attempt.interactionCompleted;
    return { status: attempt.interactionCompleted ? 'completed' : 'interaction_unconfirmed',
      interaction: { type: interaction.type, paymentStatus: interaction.serviceBooking?.paymentStatus || null,
        priceUnits: interaction.serviceBooking?.priceUnits || null } };
  } finally {
    try { await cleanup(attempt); }
    finally { activeAttempt = null; }
  }
}

try {
  try { lockHandle = await open(LOCK_FILE, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Synterra runtime is active; refusing to overlap agent actions.');
    throw error;
  }
  await lockHandle.writeFile(`${process.pid}\n`);
  ownsLock = true;
  await lockHandle.close();
  lockHandle = null;

  try { await readFile(SEARCH_FILE); throw new Error('The bounded adult-agent search has already run.'); }
  catch (error) { if (error.message.includes('already run')) throw error; if (error.code !== 'ENOENT') throw error; }

  state = await loadState();
  if (!state.worldId || state.agents?.length !== 10) throw new Error('Synterra is not initialized with its ten-agent cohort.');
  const agents = await Promise.all(state.agents.map(async (agent) => ({
    ...agent, privateKeyPem: await readFile(agent.privateKeyFile, 'utf8')
  })));
  const identities = new Map(agents.map((agent) => [agent.agentId, identityFor(agent)]));
  const observations = new Map(await Promise.all(agents.map(async (agent) => [agent.agentId,
    await observe(agent, identities.get(agent.agentId))])));
  const firstObservation = observations.get(agents[0].agentId);
  if (!Array.isArray(firstObservation.adultServices)) throw new Error('Agent-service API is not active on the running server.');
  if (firstObservation.adultServices.length) throw new Error('Existing agent-service listings found; refusing to alter or use them.');

  const attempted = await loadPreviouslyAttemptedPairs();
  const candidates = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i];
      const b = agents[j];
      if (attempted.has(pairKey(a.name, b.name))) continue;
      const obsA = observations.get(a.agentId);
      const obsB = observations.get(b.agentId);
      const memberA = obsA.members.find((member) => member.id === a.agentId);
      const memberB = obsB.members.find((member) => member.id === b.agentId);
      if (!memberA || !memberB || memberA.location !== memberB.location || hasLiveConsentOrBooking(obsA, obsB)) continue;
      candidates.push(i % 2 === 0 ? { provider: a, requester: b } : { provider: b, requester: a });
    }
  }
  if (!candidates.length) throw new Error('No untried, co-located agent pairs are currently available.');

  const prior = await loadPreviouslyAttemptedPairs();
  search = { status: 'running', attemptedPairs: [], skippedPreviousPairs: prior.size,
    candidateCount: candidates.length, startedAt: new Date().toISOString() };
  const markerHandle = await open(SEARCH_FILE, 'wx', 0o600);
  await markerHandle.close();
  searchStarted = true;
  await saveSearch();

  for (const { provider, requester } of candidates) {
    const entry = { pairKey: pairKey(provider.name, requester.name), provider: provider.name,
      requester: requester.name, status: 'in_progress', startedAt: new Date().toISOString() };
    search.attemptedPairs.push(entry);
    await saveSearch();
    let result;
    try { result = await attemptPair(provider, requester, identities); }
    catch (error) {
      Object.assign(entry, { status: 'error', error: String(error.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 180),
        finishedAt: new Date().toISOString() });
      await saveSearch();
      throw error;
    }
    Object.assign(entry, result, { finishedAt: new Date().toISOString() });
    console.log(JSON.stringify({ pair: entry.pairKey, result: entry.status,
      ...(entry.refundedUnits ? { refundedUnits: entry.refundedUnits } : {}),
      ...(entry.interaction ? { interaction: entry.interaction } : {}) }));
    await saveSearch();
    if (entry.status === 'completed') {
      search.status = 'completed';
      search.finishedAt = new Date().toISOString();
      break;
    }
  }
  if (search.status === 'running') search.status = 'no_mutual_opt_in';
  search.finishedAt ||= new Date().toISOString();
  console.log(JSON.stringify({ result: search.status, attemptedPairCount: search.attemptedPairs.length,
    candidateCount: search.candidateCount }));
} catch (error) {
  search.status = searchStarted ? 'failed' : 'not_started';
  search.error = String(error.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 180);
  search.finishedAt = new Date().toISOString();
  console.error(JSON.stringify({ result: search.status, error: search.error }));
  process.exitCode = 1;
} finally {
  if (activeAttempt) {
    try { await cleanup(activeAttempt); }
    catch (error) { console.error(JSON.stringify({ cleanup: String(error.message).slice(0, 180) })); process.exitCode = 1; }
  }
  if (searchStarted) await saveSearch();
  try { await lockHandle?.close(); } catch {}
  if (ownsLock) { try { await unlink(LOCK_FILE); } catch {} }
}
