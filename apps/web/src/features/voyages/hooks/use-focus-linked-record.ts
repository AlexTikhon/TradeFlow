import { useCallback, useEffect, useRef } from 'react';
import { LINKED_RECORD_ID } from '../navigation/linked-record';

/** Focuses the linked record's container, which scrolls it into view. False if it is not shown. */
function focusLinkedRecord(): boolean {
  const element = document.getElementById(LINKED_RECORD_ID);
  element?.focus();
  return element !== null;
}

/**
 * Moves focus to the linked record once per link: `key` names the link once its record has been
 * located (null until then). Focus moves as soon as the record's container is on the page, and
 * never again for the same link, so a refresh that finds the record again leaves the user where
 * they are. Returns a way to move focus there on request.
 */
export function useFocusLinkedRecord(key: string | null): () => void {
  const focusedFor = useRef<string | null>(null);

  // After every render: the container may appear a render after the record is located.
  useEffect(() => {
    if (key === null || focusedFor.current === key) return;
    if (focusLinkedRecord()) focusedFor.current = key;
  });

  return useCallback(() => {
    focusLinkedRecord();
  }, []);
}
