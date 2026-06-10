// @ts-check
import pino from 'pino';
import os from 'node:os';

// pino's default base fields are { pid, hostname }. We set them explicitly
// so we can add `instance` when running multiple app processes behind a
// load balancer — without it, aggregated logs from several instances are
// only distinguishable by pid, which is meaningless once logs are shipped
// off-host. INSTANCE_ID is optional; single-instance deploys can ignore it.
/** @type {{ pid: number, hostname: string, instance?: string }} */
const base = { pid: process.pid, hostname: os.hostname() };
if (process.env.INSTANCE_ID) base.instance = process.env.INSTANCE_ID;

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino/file', options: { destination: 1 } },
    formatters: { level: (/** @type {string} */ label) => ({ level: label }) },
  }),
});

export default logger;
