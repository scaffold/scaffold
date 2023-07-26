import { debugSetEpochBaseTime } from '~/sbl/EpochContract.ts';

// TODO: This is only used to make debugging easier
export const epochStartTime = Date.now();
debugSetEpochBaseTime(epochStartTime);
