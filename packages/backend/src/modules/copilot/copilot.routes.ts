import { Router } from '../../utils/router';
import { authenticate } from '../../middleware/auth';
import {
  askHandler,
  confirmActionHandler,
  createConversationHandler,
  deleteConversationHandler,
  deletePreferenceHandler,
  describeHandler,
  getConversationHandler,
  listConversationsHandler,
  listPreferencesHandler,
  listToolsHandler,
  proposeActionHandler,
  setPreferenceHandler,
  suggestionsHandler,
} from './copilot.controller';

const router = Router();

router.use(authenticate);

/*
 * Route order matters: Express matches in registration order, so literal paths
 * are declared before the `/:id` routes. `/conversations/:conversationId`
 * would otherwise swallow `/conversations/describe`.
 */

// ── Discovery ─────────────────────────────────────────────────────────────────
router.get('/describe', describeHandler);
router.get('/tools', listToolsHandler);
router.get('/suggestions', suggestionsHandler);

// ── Conversations ─────────────────────────────────────────────────────────────
router.get('/conversations', listConversationsHandler);
router.post('/conversations', createConversationHandler);
router.get('/conversations/:conversationId', getConversationHandler);
router.delete('/conversations/:conversationId', deleteConversationHandler);

// ── Asking ────────────────────────────────────────────────────────────────────
router.post('/ask', askHandler);

// ── Actions, all behind explicit confirmation ─────────────────────────────────
router.post('/actions', proposeActionHandler);
router.post('/actions/:actionId/confirm', confirmActionHandler);

// ── Preferences ───────────────────────────────────────────────────────────────
router.get('/preferences', listPreferencesHandler);
router.put('/preferences', setPreferenceHandler);
router.delete('/preferences', deletePreferenceHandler);

export default router;