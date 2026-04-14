import { loadConfig, saveConfig } from "../config/index.js";
import type { RemoteConfig } from "../config/schema.js";

export async function getRemoteConfig(): Promise<RemoteConfig> {
  const config = await loadConfig();
  return config.remote;
}

export async function hasRemoteConfigured(): Promise<boolean> {
  const remote = await getRemoteConfig();
  return remote.url != null && remote.url.trim().length > 0;
}

export async function setRemoteUrl(
  url: string,
  options: { visibilityConfirmed: boolean },
): Promise<void> {
  const config = await loadConfig();
  config.remote = {
    url,
    allowPublicRemote: config.remote.allowPublicRemote,
    visibilityConfirmed: options.visibilityConfirmed,
    lastSyncHead: null,
  };
  await saveConfig(config);
}

export async function clearRemoteConfig(): Promise<void> {
  const config = await loadConfig();
  config.remote = {
    url: null,
    allowPublicRemote: false,
    visibilityConfirmed: false,
    lastSyncHead: null,
  };
  await saveConfig(config);
}
