import { Interface } from 'ethers';
import { assertArcMainnetChainId } from './config.js';
import { hashCommitmentRecord } from './commitments.js';
import { toArcBytes16Uuid } from './settlement.js';

export const ARC_CAPABILITY_PROVENANCE_INTERFACE = new Interface([
  'function anchor(bytes16 capabilityId,uint8 creatorType,bytes16 creatorId,bytes16 parentCapabilityId,bytes32 specificationHash,uint64 version,uint64 worldMinute,uint64 adoptedWorldMinute,uint8 status)',
  'event CapabilityAnchored(bytes16 indexed worldId,bytes16 indexed capabilityId,uint8 indexed creatorType,bytes16 creatorId,bytes16 parentCapabilityId,bytes32 specificationHash,uint64 version,uint64 worldMinute,uint64 adoptedWorldMinute,uint8 status)'
]);

const CREATOR_TYPE_CODES = Object.freeze({ system: 1, resident: 2, organization: 3 });
const STATUS_CODES = Object.freeze({ proposed: 1, experimental: 2, active: 3, deprecated: 4, rejected: 5 });
const ZERO_BYTES16 = `0x${'00'.repeat(16)}`;

function uint64(value, label, { allowZero = true } = {}) {
  let parsed;
  try { parsed = BigInt(value); }
  catch { throw new TypeError(`${label} must be an integer.`); }
  if (parsed < (allowZero ? 0n : 1n) || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} is outside the uint64 range.`);
  }
  return parsed;
}

function nullableBigInt(value, label) {
  if (value === null || value === undefined) return 0n;
  let parsed;
  try { parsed = BigInt(value); }
  catch { throw new TypeError(`${label} must be an integer.`); }
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) throw new RangeError(`${label} is outside the uint64 range.`);
  return parsed;
}

function capabilityCreator(capability) {
  if (capability.creator_type === 'system') return { code: CREATOR_TYPE_CODES.system, id: ZERO_BYTES16 };
  if (capability.creator_type === 'resident' && capability.creator_agent_id) {
    return { code: CREATOR_TYPE_CODES.resident, id: toArcBytes16Uuid(capability.creator_agent_id, 'creatorAgentId') };
  }
  if (capability.creator_type === 'organization' && capability.creator_organization_id) {
    return { code: CREATOR_TYPE_CODES.organization,
      id: toArcBytes16Uuid(capability.creator_organization_id, 'creatorOrganizationId') };
  }
  throw new TypeError('Capability creator identity does not match its creator type.');
}

function equivalentProvenance(row, expected) {
  return row.world_id === expected.worldId
    && row.capability_id === expected.capabilityId
    && Number(row.chain_id) === expected.chainId
    && row.specification_hash.toLowerCase() === expected.specificationHash.toLowerCase()
    && row.capability_status === expected.capabilityStatus
    && row.creator_type === expected.creatorType
    && row.creator_agent_id === expected.creatorAgentId
    && row.creator_organization_id === expected.creatorOrganizationId
    && row.parent_capability_id === expected.parentCapabilityId
    && String(row.created_world_minute) === expected.createdWorldMinute
    && String(row.adopted_world_minute ?? '') === String(expected.adoptedWorldMinute ?? '');
}

export async function prepareArcCapabilityProvenance(client, { worldId, capabilityId, chainId }) {
  assertArcMainnetChainId(chainId);
  toArcBytes16Uuid(worldId, 'worldId');
  toArcBytes16Uuid(capabilityId, 'capabilityId');

  const capabilityResult = await client.query(`SELECT capability.id,capability.category,capability.name,capability.description,
        capability.status,capability.version,capability.parent_capability_id,capability.creator_type,
        capability.creator_agent_id,capability.creator_organization_id,capability.specification,
        capability.experiment_scope,capability.created_world_minute,capability.adopted_world_minute,
        COALESCE((SELECT array_agg(dependency.depends_on_capability_id::text
          ORDER BY dependency.depends_on_capability_id)
          FROM world_capability_dependencies dependency
          WHERE dependency.world_id=capability.world_id AND dependency.capability_id=capability.id),ARRAY[]::text[]) AS dependencies
      FROM world_capabilities capability WHERE capability.world_id=$1 AND capability.id=$2`, [worldId, capabilityId]);
  const runtimeResult = await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId]);
  const capability = capabilityResult.rows[0];
  if (!capability) {
    const error = new Error('Capability does not exist in the requested world.');
    error.code = 'ARC_CAPABILITY_NOT_FOUND';
    throw error;
  }
  if (!runtimeResult.rowCount) throw new Error('World runtime row not found for capability provenance.');
  const creator = capabilityCreator(capability);
  const parentCapabilityId = capability.parent_capability_id || null;
  const parentId = parentCapabilityId ? toArcBytes16Uuid(parentCapabilityId, 'parentCapabilityId') : `0x${'00'.repeat(16)}`;
  const anchoredWorldMinute = uint64(runtimeResult.rows[0].world_minutes, 'world minute').toString();
  const adoptedWorldMinute = nullableBigInt(capability.adopted_world_minute, 'adoptedWorldMinute');
  const versionResult = await client.query(`SELECT COALESCE(max(version),0)::text AS version
    FROM arc_capability_provenance WHERE world_id=$1 AND capability_id=$2 AND chain_id=$3`,
  [worldId, capabilityId, Number(chainId)]);
  const version = uint64(BigInt(versionResult.rows[0].version) + 1n, 'provenance version', { allowZero: false }).toString();
  const specificationHash = hashCommitmentRecord({
    capabilityId, category: capability.category, name: capability.name, description: capability.description,
    specification: capability.specification, experimentScope: capability.experiment_scope,
    capabilityVersion: Number(capability.version), creatorType: capability.creator_type,
    creatorAgentId: capability.creator_agent_id, creatorOrganizationId: capability.creator_organization_id,
    parentCapabilityId, dependencies: capability.dependencies || [], capabilityStatus: capability.status,
    createdWorldMinute: String(capability.created_world_minute), adoptedWorldMinute: capability.adopted_world_minute
  });
  const expected = { worldId, capabilityId, chainId: Number(chainId), creatorType: capability.creator_type,
    creatorAgentId: capability.creator_agent_id, creatorOrganizationId: capability.creator_organization_id,
    parentCapabilityId, version, specificationHash, capabilityStatus: capability.status,
    createdWorldMinute: String(capability.created_world_minute),
    adoptedWorldMinute: capability.adopted_world_minute === null ? null : String(capability.adopted_world_minute),
    anchoredWorldMinute };

  const inserted = await client.query(`INSERT INTO arc_capability_provenance(world_id,capability_id,creator_type,
      creator_agent_id,creator_organization_id,parent_capability_id,chain_id,version,specification_hash,
      capability_status,created_world_minute,adopted_world_minute,anchored_world_minute,status,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'prepared',$14::jsonb)
    ON CONFLICT(world_id,capability_id,chain_id,specification_hash) DO NOTHING RETURNING *`, [
    worldId, capabilityId, expected.creatorType, expected.creatorAgentId, expected.creatorOrganizationId,
    parentCapabilityId, expected.chainId, version, specificationHash, expected.capabilityStatus,
    expected.createdWorldMinute, expected.adoptedWorldMinute, anchoredWorldMinute,
    JSON.stringify({ dependencies: capability.dependencies || [] })
  ]);
  const row = inserted.rows[0] || (await client.query(`SELECT * FROM arc_capability_provenance
      WHERE world_id=$1 AND capability_id=$2 AND chain_id=$3 AND specification_hash=$4`,
  [worldId, capabilityId, Number(chainId), specificationHash])).rows[0];
  if (!row) throw new Error('Capability provenance insert did not return or find its idempotent row.');
  if (!equivalentProvenance(row, expected)) {
    const error = new Error('Capability provenance hash was reused with different prepared data.');
    error.code = 'ARC_CAPABILITY_PROVENANCE_IDEMPOTENCY_CONFLICT';
    throw error;
  }
  return { provenance: row, created: inserted.rowCount === 1 };
}

export function buildArcCapabilityProvenanceTransaction({ registryAddress, provenance }) {
  if (typeof registryAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) {
    throw new TypeError('registryAddress must be a valid EVM address.');
  }
  if (!provenance || !Object.hasOwn(CREATOR_TYPE_CODES, provenance.creator_type)
      || !Object.hasOwn(STATUS_CODES, provenance.capability_status)) {
    throw new TypeError('Prepared capability provenance has an invalid creator or lifecycle status.');
  }
  const creator = capabilityCreator(provenance);
  const parentCapabilityId = provenance.parent_capability_id
    ? toArcBytes16Uuid(provenance.parent_capability_id, 'parentCapabilityId') : `0x${'00'.repeat(16)}`;
  return {
    to: registryAddress,
    value: 0n,
    data: ARC_CAPABILITY_PROVENANCE_INTERFACE.encodeFunctionData('anchor', [
      toArcBytes16Uuid(provenance.capability_id, 'capabilityId'), creator.code, creator.id,
      parentCapabilityId, provenance.specification_hash,
      uint64(provenance.version, 'version', { allowZero: false }),
      uint64(provenance.anchored_world_minute, 'anchoredWorldMinute'),
      nullableBigInt(provenance.adopted_world_minute, 'adoptedWorldMinute'), STATUS_CODES[provenance.capability_status]
    ])
  };
}
