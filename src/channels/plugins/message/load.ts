import type { ChannelMessageAdapterShape } from "../../message/types.js";
import type { ChannelId } from "../channel-id.types.js";
import { createChannelRegistryLoader } from "../registry-loader.js";

const loadMessageAdapterFromRegistry = createChannelRegistryLoader<ChannelMessageAdapterShape>(
  (entry) => entry.plugin.message,
);

export async function loadChannelMessageAdapter(
  id: ChannelId,
): Promise<ChannelMessageAdapterShape | undefined> {
  return loadMessageAdapterFromRegistry(id);
}
