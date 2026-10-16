import {
  Box,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { DocumentaryInstructionRevision, InstructionActor } from '@tradeflow/contracts';
import type { ReactNode } from 'react';
import { formatInstant } from '../../../shared/lib/format';
import { DOCUMENT_LABELS } from '../domain/documentary-instructions';

const actor = ({ name, organization }: InstructionActor) => `${name} (${organization.name})`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Typography component="dt" variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography
        component="dd"
        variant="body2"
        sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
      >
        {children}
      </Typography>
    </div>
  );
}

interface InstructionRevisionProps {
  revision: DocumentaryInstructionRevision;
  /** Whether this revision is the one in force. */
  current: boolean;
}

/** One revision as written, with who gave it and whether the seller acknowledged it. */
export function InstructionRevision({ revision, current }: InstructionRevisionProps) {
  const { acknowledgement } = revision;
  return (
    <Box component="section" aria-label={`Revision ${revision.number}`}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 1 }}
      >
        <Typography variant="subtitle2" component="h4">
          Revision {revision.number}
          {current ? ' (current)' : ''}
        </Typography>
        <Chip
          size="small"
          label={acknowledgement ? 'Acknowledged by the seller' : 'Not acknowledged'}
          color={acknowledgement ? 'success' : current ? 'default' : 'warning'}
        />
      </Stack>

      <Box
        component="dl"
        sx={{
          m: 0,
          mb: 1.5,
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
        }}
      >
        <Fact label="Consignee">{revision.consignee}</Fact>
        <Fact label="Notify party">{revision.notifyParty ?? 'None'}</Fact>
        <Fact label="Given">
          {formatInstant(revision.createdAt)} by {actor(revision.createdBy)}
        </Fact>
        <Fact label="Acknowledged">
          {acknowledgement
            ? `${formatInstant(acknowledgement.acknowledgedAt)} by ${actor(acknowledgement.acknowledgedBy)}`
            : 'Not yet'}
        </Fact>
      </Box>

      <Table size="small" aria-label={`Documents required in revision ${revision.number}`}>
        <TableHead>
          <TableRow>
            <TableCell>Document</TableCell>
            <TableCell align="right">Originals</TableCell>
            <TableCell align="right">Copies</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {revision.requirements.map((requirement) => (
            <TableRow key={requirement.document}>
              <TableCell>{DOCUMENT_LABELS[requirement.document]}</TableCell>
              <TableCell align="right">{requirement.originals}</TableCell>
              <TableCell align="right">{requirement.copies}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
