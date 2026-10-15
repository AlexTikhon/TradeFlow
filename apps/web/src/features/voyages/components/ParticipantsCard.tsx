import {
  Card,
  CardContent,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { VoyageParticipant } from '@tradeflow/contracts';
import { formatCountry } from '../../../shared/lib/format';
import { groupParticipants, participantRoleLabel } from '../domain/participant-role';

function ParticipantsTable({
  title,
  participants,
}: {
  title: string;
  participants: VoyageParticipant[];
}) {
  return (
    <section aria-label={title}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Table size="small" aria-label={title}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: '25%' }}>Role</TableCell>
            <TableCell>Organization</TableCell>
            <TableCell sx={{ width: '25%' }}>Country</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {participants.map(({ organization, role }) => (
            <TableRow key={`${organization.id}-${role}`}>
              <TableCell>{participantRoleLabel(role)}</TableCell>
              <TableCell>{organization.name}</TableCell>
              <TableCell>{formatCountry(organization.countryCode)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function ParticipantsCard({ participants }: { participants: VoyageParticipant[] }) {
  const { tradeParties, serviceProviders } = groupParticipants(participants);
  return (
    <Card>
      <CardContent>
        <Typography variant="h2" sx={{ mb: 2 }}>
          Participating organizations
        </Typography>
        {participants.length === 0 ? (
          <Typography color="text.secondary">
            No organizations have joined this voyage yet.
          </Typography>
        ) : (
          <Stack spacing={3}>
            {tradeParties.length > 0 && (
              <ParticipantsTable title="Trade parties" participants={tradeParties} />
            )}
            {serviceProviders.length > 0 && (
              <ParticipantsTable title="Service providers" participants={serviceProviders} />
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
