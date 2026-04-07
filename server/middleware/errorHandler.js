/** Send a JSON error response using the error's status (default 500). */
export function sendError(res, err) {
  const status = err.status || 500;
  // Only expose the message for intentional application errors (status explicitly set).
  // For unexpected 500s, return a generic message to avoid leaking internals.
  const message = err.status ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}
