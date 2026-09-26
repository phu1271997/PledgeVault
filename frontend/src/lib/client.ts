import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';

export function getGenLayerClient(accountAddress?: `0x${string}`) {
  if (accountAddress) {
    return createClient({ chain: studionet, account: accountAddress });
  }
  return createClient({ chain: studionet });
}
