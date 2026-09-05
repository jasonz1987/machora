import { randomUUID } from "node:crypto";
import {
  addDeploymentTargetRecord,
  deleteDeploymentAuthorization,
  getDeploymentTargetRecord,
  listDeploymentTargets,
  queueDeploymentAccessJob,
  removeDeploymentTargetRecord,
  updateDeploymentAuthorization,
} from "./store.mjs";
import { getDeploymentProvider, listDeploymentProviderDefinitions } from "./deployment-providers/index.mjs";

export async function probeDeploymentTarget(input) {
  return getDeploymentProvider(input?.provider || "ssh").probe(input);
}

export async function createDeploymentTarget(input) {
  const provider = getDeploymentProvider(input?.provider || "ssh");
  const name = normalizeTargetName(input?.name);
  const existing = (await listDeploymentTargets()).find((target) => target.name.toLowerCase() === name.toLowerCase());
  if (existing) throw Object.assign(new Error(`Deployment target already exists: ${name}`), { statusCode: 409 });
  const id = randomUUID();
  const record = await provider.bootstrap({ id, name, input });
  try {
    return await addDeploymentTargetRecord(record);
  } catch (error) {
    await provider.remove(record).catch(() => {});
    throw error;
  }
}

export async function getDeploymentCatalog() {
  return { providers: listDeploymentProviderDefinitions(), targets: await listDeploymentTargets() };
}

export async function authorizeDeploymentTarget(targetId, hostId) {
  const target = await getDeploymentTargetRecord(targetId);
  if (target.status !== "ready") throw Object.assign(new Error("Controller trust is not ready for this deployment target"), { statusCode: 409 });
  const existing = target.authorizations?.find((item) => item.hostId === hostId);
  if (["requested", "preparing", "installing", "verifying", "revoking"].includes(existing?.status)) {
    throw Object.assign(new Error("This task-machine authorization is already in progress"), { statusCode: 409 });
  }
  const job = await queueDeploymentAccessJob(target.id, hostId, "prepare");
  const actualHostId = job.host.id;
  const updated = await updateDeploymentAuthorization(target.id, actualHostId, {
    status: "preparing",
    jobId: job.id,
    marker: `machora:target:${target.id}:host:${actualHostId}`,
    error: null,
  });
  return { target: updated, job };
}

export async function revokeDeploymentTarget(targetId, hostId) {
  const target = await getDeploymentTargetRecord(targetId);
  const authorization = target.authorizations?.find((item) => item.hostId === hostId);
  if (!authorization) throw Object.assign(new Error("This task machine is not authorized"), { statusCode: 404 });
  if (authorization.status === "revoking") throw Object.assign(new Error("Revocation is already in progress"), { statusCode: 409 });
  const provider = getDeploymentProvider(target.provider);
  await provider.revokeHost(target, authorization);
  const job = await queueDeploymentAccessJob(target.id, hostId, "revoke");
  const updated = await updateDeploymentAuthorization(target.id, hostId, {
    status: "revoking",
    jobId: job.id,
    error: null,
    revokedAt: new Date().toISOString(),
  });
  return { target: updated, job };
}

export async function deleteDeploymentTarget(targetId) {
  const target = await getDeploymentTargetRecord(targetId);
  const active = (target.authorizations || []).filter((authorization) => authorization.status !== "revoked");
  if (active.length) throw Object.assign(new Error("Revoke every task-machine authorization before deleting this target"), { statusCode: 409 });
  await getDeploymentProvider(target.provider).remove(target);
  await removeDeploymentTargetRecord(target.id);
  return true;
}

export async function handleDeploymentJobCompletion(job) {
  if (job?.type !== "deployment-access" || !job.deploymentTarget?.id || !job.host?.id) return null;
  const target = await getDeploymentTargetRecord(job.deploymentTarget.id);
  const authorization = target.authorizations?.find((item) => item.hostId === job.host.id);
  if (!authorization) return null;
  if (job.operation === "prepare") {
    if (job.status !== "succeeded") {
      return updateDeploymentAuthorization(target.id, job.host.id, { status: "error", error: job.error || "Task machine could not prepare its SSH credential" });
    }
    const prepared = {
      publicKey: job.result?.publicKey,
      fingerprint: job.result?.fingerprint,
      alias: job.result?.alias,
      configPath: job.result?.configPath,
      marker: authorization.marker,
    };
    if (!prepared.publicKey || !prepared.fingerprint) {
      return updateDeploymentAuthorization(target.id, job.host.id, { status: "error", error: "Task machine returned an incomplete SSH credential" });
    }
    await updateDeploymentAuthorization(target.id, job.host.id, { ...prepared, status: "installing", error: null });
    try {
      await getDeploymentProvider(target.provider).authorizeHost(target, prepared);
      const verifyJob = await queueDeploymentAccessJob(target.id, job.host.id, "verify");
      return updateDeploymentAuthorization(target.id, job.host.id, { status: "verifying", jobId: verifyJob.id, error: null });
    } catch (error) {
      return updateDeploymentAuthorization(target.id, job.host.id, { status: "error", error: error.message });
    }
  }
  if (job.operation === "verify") {
    return updateDeploymentAuthorization(target.id, job.host.id, job.status === "succeeded"
      ? { status: "ready", jobId: job.id, error: null, authorizedAt: new Date().toISOString() }
      : { status: "error", jobId: job.id, error: job.error || "Task machine could not connect to the deployment target" });
  }
  if (job.operation === "revoke") {
    if (job.status === "succeeded") {
      await deleteDeploymentAuthorization(target.id, job.host.id);
      return null;
    }
    return updateDeploymentAuthorization(target.id, job.host.id, { status: "cleanup-error", jobId: job.id, error: job.error || "Server access was revoked, but task-machine credential cleanup failed" });
  }
  return null;
}

function normalizeTargetName(value) {
  const name = String(value || "").trim();
  if (name.length < 2 || name.length > 80) throw Object.assign(new Error("Deployment target name must be 2–80 characters"), { statusCode: 400 });
  return name;
}
