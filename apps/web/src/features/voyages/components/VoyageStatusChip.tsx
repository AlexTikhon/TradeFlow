import { Chip } from '@mui/material';
import type { VoyageStatus } from '@tradeflow/contracts';
import { VOYAGE_STATUS_PRESENTATION } from '../domain/voyage-status';

export function VoyageStatusChip({ status }: { status: VoyageStatus }) {
  const { label, color } = VOYAGE_STATUS_PRESENTATION[status];
  return <Chip label={label} color={color} size="small" variant="outlined" />;
}
