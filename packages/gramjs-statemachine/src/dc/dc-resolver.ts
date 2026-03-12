/** DC address type */
export interface TelegramDcAddress {
  id: number;
  ip: string;
  port: number;
}

export type DcMode = 'production' | 'test';

const DEFAULT_DC_ID = 2;

const PRODUCTION_DCS: Record<number, TelegramDcAddress> = {
  1: { id: 1, ip: '149.154.175.59', port: 443 },
  2: { id: 2, ip: '149.154.167.50', port: 443 },
  3: { id: 3, ip: '149.154.175.100', port: 443 },
  4: { id: 4, ip: '149.154.167.91', port: 443 },
  5: { id: 5, ip: '91.108.56.153', port: 443 },
};

const TEST_DCS: Record<number, TelegramDcAddress> = {
  1: { id: 1, ip: '149.154.175.55', port: 443 },
  2: { id: 2, ip: '149.154.167.40', port: 443 },
  3: { id: 3, ip: '149.154.175.100', port: 443 },
  4: { id: 4, ip: '149.154.167.92', port: 443 },
  5: { id: 5, ip: '91.108.56.180', port: 443 },
};

function getDcMap(mode: DcMode): Record<number, TelegramDcAddress> {
  return mode === 'test' ? TEST_DCS : PRODUCTION_DCS;
}

export function getDefaultTelegramDc(mode: DcMode): TelegramDcAddress {
  return getDcMap(mode)[DEFAULT_DC_ID];
}

export function resolveTelegramDc(
  mode: DcMode,
  dcId: number,
): TelegramDcAddress {
  const dc = getDcMap(mode)[dcId];
  if (!dc) {
    throw new Error(`unsupported ${mode} DC ${dcId}`);
  }
  return dc;
}

/** Parse a *_MIGRATE_N error message and return the target DC ID, or undefined. */
export function parseMigrateDc(errorMessage: string | undefined): number | undefined {
  if (!errorMessage) return undefined;
  const match = errorMessage.match(/(?:PHONE|NETWORK|USER|FILE)_MIGRATE_(\d+)/);
  return match ? Number(match[1]) : undefined;
}
