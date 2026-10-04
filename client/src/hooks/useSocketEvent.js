// =============================================================================
// Subscribe to one socket event for the lifetime of a component.
//
// The cleanup uses socket.off(event, handler) — removing exactly OUR handler.
// Never socket.removeAllListeners(): that would silently tear off every other
// component's subscription to the same event, and the symptom ("this panel
// stopped updating after I closed that other panel") is miserable to trace.
// =============================================================================

import { useEffect, useRef } from 'react';
import { socket } from '../lib/socket';

export function useSocketEvent(event, handler) {
  // Keep the latest handler in a ref so the subscription itself never has to
  // be torn down and rebuilt when the parent re-renders with a new closure.
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const listener = (...args) => ref.current(...args);
    socket.on(event, listener);
    return () => socket.off(event, listener);
  }, [event]);
}
