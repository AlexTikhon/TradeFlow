import { useCallback, useEffect, useState } from 'react';
import { COLLAPSED_SELECTOR, LINKED_RECORD_ID } from '../navigation/linked-record';

/**
 * Moves focus to the linked record's container, which scrolls it into view, if it is shown: on
 * the page and inside no collapsed history (which keeps what it hides mounted, so being on the
 * page proves nothing).
 */
function focusLinkedRecord(): void {
  const element = document.getElementById(LINKED_RECORD_ID);
  if (element && !element.closest(COLLAPSED_SELECTOR)) element.focus();
}

export interface RevealLinkedRecord {
  /** The request to reveal the record still being carried out, by number; null when none is. */
  request: number | null;
  /** Asks again: history around the record opens, even if the user folded it, and focus moves. */
  show: () => void;
}

/**
 * Reveals the linked record on request: `key` names the link once its record has been located
 * (null until then). A link not seen before is a request, and so is every `show`; each has a
 * number of its own. The pending request is provided to the sections (`RevealRequestContext`),
 * whose collapsed history holding the record opens for it (`useDisclosure`); focus then moves to
 * the record's container once nothing collapsed hides it. Focus landing there fulfils the
 * request: an element that refuses focus leaves it pending.
 *
 * Nothing else asks: a refresh that finds the record again, or finds it elsewhere (a revision
 * superseded meanwhile), opens nothing and leaves focus where the user put it, and so does the
 * same link located again.
 */
export function useRevealLinkedRecord(key: string | null): RevealLinkedRecord {
  const [requested, setRequested] = useState<{ key: string | null; number: number }>({
    key: null,
    number: 0,
  });
  const [fulfilled, setFulfilled] = useState(0);
  if (key !== null && key !== requested.key) {
    setRequested({ key, number: requested.number + 1 });
  }
  const request = key !== null && requested.number !== fulfilled ? requested.number : null;

  // After every render while a request is pending: the container may appear, or the history
  // around it open, a render after the record is located.
  useEffect(() => {
    if (request === null) return;
    const fulfil = ({ target }: FocusEvent) => {
      if (target instanceof Element && target.id === LINKED_RECORD_ID) setFulfilled(request);
    };
    document.addEventListener('focusin', fulfil);
    focusLinkedRecord();
    return () => {
      document.removeEventListener('focusin', fulfil);
    };
  });

  const show = useCallback(() => {
    setRequested((current) => ({ ...current, number: current.number + 1 }));
  }, []);
  return { request, show };
}
