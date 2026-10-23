import type { SxProps, Theme } from '@mui/material';
import { createContext, useContext, useState } from 'react';
import type { LinkedRecord } from './record-resolution';

/*
 * How the voyage page's sections take part in opening a record link. The page resolves the link
 * once per render and provides the record it found; the section that shows that record marks its
 * container (`linkedRecordProps`), and any collapsed history around it opens (`useDisclosure`).
 * The page then moves focus to the marked container, once per link.
 */

/** The record the page's link names, once located; null otherwise. */
export const LinkedRecordContext = createContext<LinkedRecord | null>(null);

export const useLinkedRecord = (): LinkedRecord | null => useContext(LinkedRecordContext);

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
 * The open state of a collapsed section that may hold the linked record. It opens when `reveal`
 * becomes true, and only then: the user may close it again, and a refresh that finds the same
 * record does not reopen it.
 */
export function useDisclosure(reveal: boolean) {
  const [expanded, setExpanded] = useState(reveal);
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal) setExpanded(true);
  }
  return [expanded, setExpanded] as const;
}
