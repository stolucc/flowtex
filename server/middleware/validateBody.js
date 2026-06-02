// Generic body-schema validator. Wraps a Zod schema and returns an Express
// middleware that:
//   - Parses req.body through the schema
//   - On success, replaces req.body with the parsed (and coerced) value
//     so downstream handlers can rely on the shape
//   - On failure, returns 400 with the first error's path + message
//
// Why this exists: ASVS V13.2.2 prefers declarative schema validation
// over scattered `if (typeof x !== 'string')` checks. A schema:
//   - Documents the route contract in one place
//   - Catches type/shape errors uniformly with consistent error messages
//   - Strips unknown fields (when the schema is `.strict()`)
//   - Stays in sync with the route — diverging is a compile-time-ish
//     mistake, not a silent runtime drift
//
// Usage:
//   import { z } from 'zod';
//   import validateBody from '../middleware/validateBody.js';
//
//   const loginSchema = z.object({
//     email: z.string().email().max(254),
//     password: z.string().min(1).max(1024),
//     totpCode: z.string().regex(/^\d{6}$/).optional(),
//   }).strict();
//
//   router.post('/login', validateBody(loginSchema), async (req, res) => {
//     // req.body is now { email, password, totpCode? } — guaranteed shape
//   });
//
// Don't catch ZodError downstream — the middleware already turned it
// into a 400. Don't re-validate inside the handler.

export default function validateBody(schema) {
  return function validateBodyMiddleware(req, res, next) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      // First error wins. ASVS V7.1.1: don't echo internal stack traces;
      // do echo the field path + the validation message so the caller
      // can fix their request. Zod's default messages are user-friendly
      // ("Invalid email", "String must contain at most N character(s)").
      const issue = result.error.issues[0];
      const field = issue.path.length > 0 ? issue.path.join('.') : '(body)';
      return res.status(400).json({
        error: `Invalid request: ${field} — ${issue.message}`,
      });
    }
    req.body = result.data;
    next();
  };
}
