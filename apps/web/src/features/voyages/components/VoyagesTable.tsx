import {
  Link,
  Paper,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { VoyageSummary } from '@tradeflow/contracts';
import { Link as RouterLink } from 'react-router';
import { formatLaycan, formatQuantity } from '../../../shared/lib/format';
import { VoyageStatusChip } from './VoyageStatusChip';

const COLUMN_COUNT = 7;
const SKELETON_ROWS = 5;

interface VoyagesTableProps {
  voyages: VoyageSummary[] | undefined;
  isLoading: boolean;
}

export function VoyagesTable({ voyages, isLoading }: VoyagesTableProps) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table aria-label="Voyages" aria-busy={isLoading}>
        <TableHead>
          <TableRow>
            <TableCell>Reference</TableCell>
            <TableCell>Vessel</TableCell>
            <TableCell>Commodity</TableCell>
            <TableCell align="right">Quantity</TableCell>
            <TableCell>Route</TableCell>
            <TableCell>Laycan</TableCell>
            <TableCell>Status</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {isLoading && <SkeletonRows />}
          {voyages?.length === 0 && (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT}>
                <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                  No voyages match this filter.
                </Typography>
              </TableCell>
            </TableRow>
          )}
          {voyages?.map((voyage) => (
            <TableRow key={voyage.id} hover>
              <TableCell>
                <Link component={RouterLink} to={`/voyages/${voyage.id}`} sx={{ fontWeight: 600 }}>
                  {voyage.reference}
                </Link>
              </TableCell>
              <TableCell>{voyage.vessel.name}</TableCell>
              <TableCell>{voyage.commodity.name}</TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatQuantity(voyage.quantity)}
              </TableCell>
              <TableCell>
                {voyage.loadPort.name} → {voyage.dischargePort.name}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatLaycan(voyage.laycan)}</TableCell>
              <TableCell>
                <VoyageStatusChip status={voyage.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function SkeletonRows() {
  return Array.from({ length: SKELETON_ROWS }, (_, row) => (
    <TableRow key={row}>
      {Array.from({ length: COLUMN_COUNT }, (_, cell) => (
        <TableCell key={cell}>
          <Skeleton />
        </TableCell>
      ))}
    </TableRow>
  ));
}
