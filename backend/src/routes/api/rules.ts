/**
 * Mail rules (src/rules): CRUD, a preview of how much existing INBOX mail a match would change,
 * and the explicit, bounded apply-to-existing. Saving a rule never touches old mail on its own —
 * it acts only on mail that arrives after it was created.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createRule,
  deleteRule,
  listRules,
  RuleInputError,
  setRuleEnabled,
  updateRule,
  validateRuleInput,
} from '../../rules/store.js';
import { applyRuleToExisting, previewRule } from '../../rules/apply.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof RuleInputError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rules', async () => ({ rules: listRules() }));

  app.post('/api/rules', async (req, reply) => {
    try {
      return reply.code(201).send({ rule: createRule(validateRuleInput(req.body)) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full replace of match + actions; `createdAt` (the arrival cut-off) is kept.
  app.put<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    try {
      return { rule: updateRule(req.params.id, validateRuleInput(req.body)) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>(
    '/api/rules/:id',
    async (req, reply) => {
      if (typeof req.body?.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be a boolean' });
      }
      const rule = setRuleEnabled(req.params.id, req.body.enabled);
      if (!rule) return reply.code(404).send({ error: 'rule not found' });
      return { rule };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    if (!deleteRule(req.params.id)) return reply.code(404).send({ error: 'rule not found' });
    return { ok: true };
  });

  // Takes a rule body (saved or not) so the form can show the impact before anything is saved.
  app.post('/api/rules/preview', async (req, reply) => {
    try {
      return previewRule(validateRuleInput(req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // One bounded pass; the client calls again while `remaining` > 0.
  app.post<{ Params: { id: string } }>('/api/rules/:id/apply', async (req, reply) => {
    const result = applyRuleToExisting(req.params.id);
    if (result === undefined) return reply.code(404).send({ error: 'rule not found' });
    if (result === null) return reply.code(409).send({ error: 'rule is disabled' });
    return result;
  });
}
