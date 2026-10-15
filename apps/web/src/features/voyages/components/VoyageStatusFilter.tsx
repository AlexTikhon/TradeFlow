import { TextField } from '@mui/material';
import { VOYAGE_STATUSES, type VoyageStatus } from '@tradeflow/contracts';
import { VOYAGE_STATUS_PRESENTATION } from '../domain/voyage-status';

interface VoyageStatusFilterProps {
  value: VoyageStatus | undefined;
  onChange: (status: VoyageStatus | undefined) => void;
}

const ALL = '';

export function VoyageStatusFilter({ value, onChange }: VoyageStatusFilterProps) {
  return (
    <TextField
      select
      label="Status"
      size="small"
      value={value ?? ALL}
      onChange={(event) => {
        const next = VOYAGE_STATUSES.find((status) => status === event.target.value);
        onChange(next);
      }}
      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      sx={{ minWidth: 200 }}
    >
      <option value={ALL}>All statuses</option>
      {VOYAGE_STATUSES.map((status) => (
        <option key={status} value={status}>
          {VOYAGE_STATUS_PRESENTATION[status].label}
        </option>
      ))}
    </TextField>
  );
}
