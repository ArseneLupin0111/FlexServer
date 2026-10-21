import { loadComposeKeyring, rewrapComposeEnvelope, type ComposeAdminContext, type ComposeAdminStoreConfig, type ComposeAadContext, type ComposeEnvelopeData } from "../../crypto/secret-envelope.js";
import { createPostgresApplicationsRepository, createJsonApplicationsRepository, type ApplicationsState, type PreviewRow } from "./applications.repository.js";
import { Pool } from "pg";
import type { Keyring } from "../../ssh/key-encryption.js";

type EnvelopeRecord = { envelope: ComposeEnvelopeData; context: ComposeAadContext; location: string };

const scanState = (state: ApplicationsState): EnvelopeRecord[] => {
  const records: EnvelopeRecord[] = [];
  for (const revision of state.revisions)
    records.push({ envelope: revision.envelope, context: { vpsId: revision.vpsId, appId: revision.appId, field: "composeYaml", version: revision.seq }, location: `revisions:${revision.id}` });
  for (const secret of state.secrets)
    records.push({ envelope: secret.envelope, context: { vpsId: secret.vpsId, appId: secret.appId, field: "secret", version: `${secret.name}:${secret.version}` }, location: `secrets:${secret.id}` });
  for (const credential of state.credentials)
    records.push({ envelope: credential.envelope, context: { vpsId: credential.vpsId, appId: "registry", field: "registryCredential", version: credential.version }, location: `credentials:${credential.id}` });
  for (const preview of state.previews) {
    if (preview.resolvedModelEnvelope)
      records.push({ envelope: preview.resolvedModelEnvelope, context: { vpsId: preview.vpsId, appId: preview.appId, field: "resolvedModel", version: preview.revisionSeq }, location: `previews:${preview.id}` });
  }
  return records;
};

const unresolvedAppIds = (state: ApplicationsState): string[] => {
  const refused: string[] = [];
  for (const operation of state.operations)
    if (!["succeeded", "failed", "cancelled"].includes(operation.status) && operation.appId && !refused.includes(operation.appId))
      refused.push(operation.appId);
  return refused;
};

const createAdminDatabasePool = (config: ComposeAdminStoreConfig): Pool => {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required to create a database pool");
  return new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, ...(config.dbSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
};

export function createComposeAdminContext(config: ComposeAdminStoreConfig): Promise<ComposeAdminContext & { __release: () => Promise<void> }> {
  return (async () => {
    const pool = config.storageDriver === "postgres" ? createAdminDatabasePool(config) : undefined;
    const repository = pool ? createPostgresApplicationsRepository(pool) : createJsonApplicationsRepository(config.dataDir);
    return {
      async hasEncryptedFields() {
        return repository.transaction(state => scanState(state).length > 0);
      },
      async rotateEncryptedFields(options) {
        let keyring: Keyring;
        try { keyring = await loadComposeKeyring(config.composeCrypto.keyringFile); }
        catch { return { rewrapped: 0, refusedAppIds: [], kekIds: [], conflictCode: "crypto_unavailable" as const }; }
        try {
          return await repository.transaction(state => {
            const refusedAppIds = unresolvedAppIds(state);
            if (refusedAppIds.length > 0) return { rewrapped: 0, refusedAppIds, kekIds: [], conflictCode: "busy" as const };
            const records = scanState(state);
            const kekIds = [...new Set(records.map(record => record.envelope.kekId))];
            if (options?.dryRun) return { rewrapped: records.length, refusedAppIds: [], kekIds };
            let rewrapped = 0;
            for (const record of records) {
              const envelope = rewrapComposeEnvelope(record.envelope, record.context, keyring);
              const [section, id] = record.location.split(":");
              if (section === "revisions") { const row = state.revisions.find(r => r.id === id); if (row) row.envelope = envelope; }
              else if (section === "secrets") { const row = state.secrets.find(r => r.id === id); if (row) row.envelope = envelope; }
              else if (section === "credentials") { const row = state.credentials.find(r => r.id === id); if (row) row.envelope = envelope; }
              else if (section === "previews") { const row: PreviewRow | undefined = state.previews.find(p => p.id === id); if (row) row.resolvedModelEnvelope = envelope; }
              rewrapped++;
            }
            return { rewrapped, refusedAppIds: [], kekIds };
          });
        } catch { return { rewrapped: 0, refusedAppIds: [], kekIds: [], conflictCode: "crypto_unavailable" as const }; }
      },
      __release: async () => { await repository.close(); await pool?.end(); },
    };
  })();
}

