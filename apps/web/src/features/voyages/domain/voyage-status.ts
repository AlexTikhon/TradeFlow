import type { VoyageStatus } from '@tradeflow/contracts';

type ChipColor = 'default' | 'info' | 'primary' | 'secondary' | 'success' | 'warning' | 'error';

/** Exhaustive by type: adding a status to the contract fails compilation here until handled. */
export const VOYAGE_STATUS_PRESENTATION: Record<VoyageStatus, { label: string; color: ChipColor }> =
  {
    PLANNED: { label: 'Planned', color: 'default' },
    LOADING: { label: 'Loading', color: 'info' },
    IN_TRANSIT: { label: 'In transit', color: 'primary' },
    DISCHARGING: { label: 'Discharging', color: 'secondary' },
    COMPLETED: { label: 'Completed', color: 'success' },
    CANCELLED: { label: 'Cancelled', color: 'error' },
  };
