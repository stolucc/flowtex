// @ts-check
/// <reference types="express-session" />
// SAAS-FOUNDATIONS item 5 -- pluggable error reporter.
//
// Shape modelled on Sentry's Node SDK (captureException +
// setUserContext + setTag) so an operator can drop in @sentry/node
// (or any compatible client -- Bugsnag, Honeycomb errors) without
// rewriting call sites. The default is a no-op: self-hosted installs
// don't pay for a dependency they don't use; the on-disk install
// guide is "self-hosters keep the default; SaaS ops register an
// implementation at boot."
//
// Why not import @sentry/node directly?
//   - Adds 4 MB to the install footprint.
//   - The SaaS posture is one of several: some shops standardise on
//     Bugsnag, others on Honeycomb, others on cloud-provider error
//     reporters. A pluggable boundary keeps FlowTex provider-agnostic.
//   - The optional-dynamic-import alternative (require('@sentry/node')
//     when SENTRY_DSN is set) leaks the choice into FlowTex's lock
//     file, which is the wrong place.
//
// Failure mode: every entrypoint is wrapped in try/catch. A broken
// reporter cannot take down the request that triggered it.

import logger from '../logger.js';

/** Shape every registered implementation must provide. Each method is
 *  optional -- the helpers below null-check at the call site so an
 *  implementation can ship only the parts it cares about. */
/**
 * @typedef {{
 *   captureException?: (err: unknown, context?: object) => void,
 *   setUserContext?: (user: object | null | undefined) => void,
 *   setTag?: (key: string, value: unknown) => void,
 * }} ErrorReporterImpl
 */

/** @type {ErrorReporterImpl | null} */
let impl = null;

/**
 * Register an error-reporter implementation. The shape it must
 * provide:
 *
 *   {
 *     captureException(err, context?)
 *     setUserContext(user?)
 *     setTag(key, value)
 *   }
 *
 * Each method is called from many places -- they must be cheap and
 * non-throwing. The reporter is responsible for batching, transport,
 * and PII scrubbing.
 *
 * @example
 *   import * as Sentry from '@sentry/node';
 *   Sentry.init({ dsn: process.env.SENTRY_DSN });
 *   registerErrorReporter({
 *     captureException: (e, ctx) => Sentry.captureException(e, { extra: ctx }),
 *     setUserContext: (u) => Sentry.setUser(u || null),
 *     setTag: (k, v) => Sentry.setTag(k, v),
 *   });
 */
/** @param {ErrorReporterImpl} implementation */
export function registerErrorReporter(implementation) {
  if (!implementation || typeof implementation !== 'object') {
    logger.warn('registerErrorReporter: invalid implementation ignored');
    return;
  }
  impl = implementation;
}

/** Clear the registered reporter. Tests + reinit only. */
export function _clearErrorReporter() {
  impl = null;
}

/** Returns true when an implementation has been registered. */
export function isErrorReporterRegistered() {
  return impl !== null;
}

/**
 * @param {unknown} err
 * @param {object} [context]
 */
export function captureException(err, context) {
  if (!impl?.captureException) return;
  try {
    impl.captureException(err, context);
  } catch (reporterErr) {
    // Reporter blew up -- log locally and move on. We never let the
    // observability layer take down a request.
    logger.warn({ err: reporterErr }, 'errorReporter: captureException threw');
  }
}

/** @param {object | null | undefined} user */
export function setUserContext(user) {
  if (!impl?.setUserContext) return;
  try {
    impl.setUserContext(user);
  } catch (reporterErr) {
    logger.warn({ err: reporterErr }, 'errorReporter: setUserContext threw');
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 */
export function setTag(key, value) {
  if (!impl?.setTag) return;
  try {
    impl.setTag(key, value);
  } catch (reporterErr) {
    logger.warn({ err: reporterErr }, 'errorReporter: setTag threw');
  }
}

/**
 * Express error-handler middleware variant. Mount AFTER all routes;
 * captures the exception and re-emits via next() so the existing
 * error response code path stays in charge.
 */
/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function errorReporterMiddleware(err, req, res, next) {
  captureException(err, {
    method: req?.method,
    url: req?.originalUrl,
    userId: req?.session?.userId,
    statusCode: res?.statusCode,
  });
  next(err);
}
