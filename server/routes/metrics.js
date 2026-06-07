// SAAS-FOUNDATIONS item 5 -- /metrics endpoint for Prometheus.
//
// Mounted at `/metrics` on the same Express app as the rest of the
// API. The endpoint is unauthenticated by design: Prometheus scrapes
// it from inside the network perimeter (e.g. a sidecar in the same
// k8s pod or a VPC-internal scraper). For internet-facing deploys
// the operator restricts access via firewall / reverse-proxy ACL
// rather than at the app layer -- consistent with how Overleaf's
// libraries/metrics module works.

import { Router } from 'express';
import { getRegistry } from '../services/metrics.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const registry = getRegistry();
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  } catch (err) {
    res.status(500).type('text/plain').send(`# metrics error: ${err?.message || 'unknown'}\n`);
  }
});

export default router;
