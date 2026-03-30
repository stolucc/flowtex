export function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.message });
}
