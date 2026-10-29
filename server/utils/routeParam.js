// @ts-check
// Express 5 types req.params values as `string | string[]` (wildcard
// segments like `*splat` are arrays). Named `:id` segments are always
// strings at runtime; this narrows them for the type checker. Anything
// else becomes '' so the caller's UUID / shape check rejects it.

/**
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string}
 */
export function routeParam(req, name) {
  const v = req.params[name];
  return typeof v === 'string' ? v : '';
}
