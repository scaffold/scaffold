/**
 * Shared postgres client type used by metric compute() functions.
 */

import postgres from 'postgres';

export type Sql = ReturnType<typeof postgres>;
