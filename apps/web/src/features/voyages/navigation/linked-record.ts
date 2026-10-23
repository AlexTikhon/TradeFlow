import type { SxProps, Theme } from '@mui/material';
import { createContext, useContext, useState } from 'react';
import type { LinkedRecord } from './record-resolution';

/*
 * How the voyage page's sections take part in opening a record link. The page resolves the link
 * once per render and provides the record it found; the section that shows that record marks its
 * container (`linkedRecordProps`). Revealing it is a request (a new link, or "Show it"): any
 * collapsed history around the record opens for it (`useDisclosure`), and the page then moves
 * focus to the marked container (`useRevealLinkedRecord`).
 */

/** The record the page's link names, once located; null otherwise. */
export const LinkedRecordContext = createContext<LinkedRecord | null>(null);

export const useLinkedRecord = (): LinkedRecord | null => useContext(LinkedRecordContext);

/** The page's pending request to reveal the linked record, by number; null when there is none. */
export const RevealRequestContext = createContext<number | null>(null);

/** Id of the container of the linked record: there is at most one on the page. */
export const LINKED_RECORD_ID = 'linked-record';
/** Id of the page's explanation of the link, which describes the container. */
export const LINKED_RECORD_STATUS_ID = 'linked-record-status';

/** Attributes for the container of the linked record: focusable by script, described, marked. */
export const linkedRecordProps = {
  id: LINKED_RECORD_ID,
  tabIndex: -1,
  'aria-describedby': LINKED_RECORD_STATUS_ID,
} as const;

/** Styles for that container: outlined, and kept clear of the sticky app bar when scrolled to. */
export const linkedRecordSx = {
  outline: 2,
  outlineColor: 'primary.main',
  outlineOffset: 2,
  borderRadius: 1,
  scrollMarginTop: 96,
} satisfies SxProps<Theme>;

/**
 * Marks the content of collapsed history (`data-collapsed`), which stays mounted while hidden:
 * the page never treats a record in there as shown.
 */
export const COLLAPSED_SELECTOR = '[data-collapsed]';

/**
 * The open state of collapsed history that may hold the linked record (`holdsLinkedRecord`). It
 * opens for each request to reveal the record that arrives while it holds it, whatever the user
 * did with it before, and for nothing else: the user may fold it again, and a refresh does not
 * reopen it, even one that moves the record into it.
 */
export function useDisclosure(holdsLinkedRecord: boolean) {
  const request = useContext(RevealRequestContext);
  const wanted = holdsLinkedRecord ? request : null;
  const [expanded, setExpanded] = useState(wanted !== null);
  // The last request this history opened for, so that it opens once per request.
  const [answered, setAnswered] = useState(wanted);
  if (wanted !== null && wanted !== answered) {
    setAnswered(wanted);
    setExpanded(true);
  }
  return [expanded, setExpanded] as const;
}
