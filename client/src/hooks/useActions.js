// =============================================================================
// useActions — fire an action, and know what it's doing right now.
//
// `busy[target]` is the live stage of whatever is running on that container:
//   'requesting' → 'executing' → 'verifying' → (gone)
// The card uses it to disable its button and label the spinner.
//
// THE SPINNER IS NOT CLEARED ON HTTP SUCCESS. The server answers 202 the
// instant it accepts the request; the restart hasn't happened yet. We only
// clear when the socket says the action finished (verified / failed /
// denied). The click is a request, not a result.
//
// Mounted ONCE, in Dashboard. Also owns the toasts for action outcomes, so
// there's exactly one place that turns socket events into messages.
// =============================================================================

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { postAction } from '../lib/api';
import { useSocketEvent } from './useSocketEvent';
import { actionLabel } from '../lib/format';

const FINISHED = new Set(['verified', 'failed', 'denied']);

export function useActions() {
  const [busy, setBusy] = useState({});   // target → stage

  const setStage = (target, stage) =>
    setBusy((b) => {
      if (stage == null) { const { [target]: _, ...rest } = b; return rest; }
      return { ...b, [target]: stage };
    });

  // --- Outcomes, from the socket -------------------------------------------
  useSocketEvent('action', (a) => {
    const label = actionLabel(a.action_type);

    switch (a.stage) {
      case 'executing':
        setStage(a.target, 'executing');
        break;
      case 'executed':
      case 'verifying':
        setStage(a.target, 'verifying');
        break;
      case 'verified': {
        const s = a.verification?.recovery_ms != null ? ` — healthy after ${(a.verification.recovery_ms / 1000).toFixed(1)}s` : '';
        toast.success(`${label} on ${a.target} verified${s}`);
        break;
      }
      case 'failed':
        toast.error(`${label} on ${a.target} failed: ${a.error}`, { duration: 8000 });
        break;
      case 'denied':
        // The policy.denied handler below owns this toast.
        break;
    }
    if (FINISHED.has(a.stage)) setStage(a.target, null);
  });

  // The refusal. A RED TOAST, not a log line — restarting sre-postgres and
  // watching it get blocked in front of an audience is one of the best three
  // seconds of the demo.
  useSocketEvent('policy.denied', (d) => {
    toast.error(`Action blocked: ${d.reason}`, {
      description: `${actionLabel(d.action)} on ${d.target} · ${d.code}`,
      duration: 8000,
    });
    setStage(d.target, null);
  });

  // --- Firing ----------------------------------------------------------------
  const run = useCallback(async ({ action, target, incidentId }) => {
    setStage(target, 'requesting');
    try {
      await postAction({ action, target, incidentId });
      // Leave the stage set; the socket will advance and clear it.
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message;
      toast.error(`Could not request ${actionLabel(action)}: ${msg}`);
      setStage(target, null);
    }
  }, []);

  return { busy, run };
}
