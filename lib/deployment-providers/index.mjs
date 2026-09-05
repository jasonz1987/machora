import { sshDeploymentProvider } from "./ssh.mjs";

const providers = new Map([[sshDeploymentProvider.type, sshDeploymentProvider]]);

export function getDeploymentProvider(type) {
  const provider = providers.get(String(type || "").toLowerCase());
  if (!provider) throw Object.assign(new Error(`Unsupported deployment provider: ${type}`), { statusCode: 400 });
  return provider;
}

export function listDeploymentProviderDefinitions() {
  return [...providers.values()].map(({ type, label }) => ({ type, label }));
}
