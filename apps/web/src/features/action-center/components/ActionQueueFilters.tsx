import { Checkbox, FormControlLabel, Stack, TextField } from '@mui/material';
import { ACTION_ITEM_TYPES } from '@tradeflow/contracts';
import type { ActionItemFilters } from '../api/action-items.api';
import { ACTION_TYPE_LABELS } from '../domain/action-items';

interface ActionQueueFiltersProps {
  value: ActionItemFilters;
  onChange: (filters: ActionItemFilters) => void;
}

const ALL = '';

/** The queue's filters: one type of action, and overdue only. Both are applied by the API. */
export function ActionQueueFilters({ value, onChange }: ActionQueueFiltersProps) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={{ xs: 1, sm: 2 }}
      sx={{ alignItems: { sm: 'center' } }}
    >
      <TextField
        select
        label="Action"
        size="small"
        value={value.type ?? ALL}
        onChange={(event) => {
          const type = ACTION_ITEM_TYPES.find((candidate) => candidate === event.target.value);
          onChange({ ...(type && { type }), ...(value.overdue && { overdue: true as const }) });
        }}
        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
        sx={{ minWidth: 240 }}
      >
        <option value={ALL}>All actions</option>
        {ACTION_ITEM_TYPES.map((type) => (
          <option key={type} value={type}>
            {ACTION_TYPE_LABELS[type]}
          </option>
        ))}
      </TextField>
      <FormControlLabel
        label="Overdue only"
        control={
          <Checkbox
            checked={value.overdue === true}
            onChange={(event) => {
              onChange({
                ...(value.type && { type: value.type }),
                ...(event.target.checked && { overdue: true as const }),
              });
            }}
          />
        }
      />
    </Stack>
  );
}
